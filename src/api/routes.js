import express from 'express';
import { feishuService } from '../services/feishu.js';
import { didiService } from '../services/didi.js';
import { emailService } from '../services/email.js';
import { matcherService } from '../services/matcher.js';
import { logger } from '../services/logger.js';

const router = express.Router();

// Cache for Didi rules
let didiRulesCache = { rules: [], expiresAt: 0 };
const CACHE_TTL = 5 * 60 * 1000;

async function getDidiRules() {
  if (didiRulesCache.rules.length && Date.now() < didiRulesCache.expiresAt) {
    return didiRulesCache.rules;
  }
  try {
    const rules = await didiService.fetchRegulations();
    didiRulesCache = { rules, expiresAt: Date.now() + CACHE_TTL };
    return rules;
  } catch (error) {
    logger.error('Failed to fetch Didi rules', { error: error.message });
    return didiRulesCache.rules;
  }
}

/**
 * GET /api/hires
 * Query params: 
 *   status=preboarding|completed (default: preboarding)
 *   all=true 不过滤已开通邮箱的人员
 */
router.get('/hires', async (req, res) => {
  try {
    const status = req.query.status || 'preboarding';
    const showAll = req.query.all === 'true';
    logger.info(`Fetching ${status} hires (showAll: ${showAll})`);

    const preHires = await feishuService.getEnrichedPreHires(status, showAll);
    logger.info(`Found ${preHires.length} ${status} hires`);

    // Generate suggested emails
    const withEmails = await emailService.batchGenerateEmails(preHires);

    // Match Didi rules if completed status
    let enriched = withEmails;
    if (status === 'completed') {
      const didiRules = await getDidiRules();
      enriched = matcherService.batchMatchRules(withEmails, didiRules);
    }

    logger.success(`Hires list enriched successfully`);

    res.json({
      success: true,
      data: enriched,
      total: enriched.length
    });
  } catch (error) {
    logger.error('Failed to fetch hires', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/didi/rules
 */
router.get('/didi/rules', async (req, res) => {
  try {
    const rules = await getDidiRules();
    res.json({ success: true, data: rules });
  } catch (error) {
    logger.error('Failed to fetch Didi rules', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/provision/email
 * Single email provisioning with auto-retry for duplicates
 */
router.post('/provision/email', async (req, res) => {
  const { id, name, email } = req.body;

  if (!id || !name) {
    return res.status(400).json({ success: false, error: 'id and name are required' });
  }

  try {
    logger.info(`Provisioning email for ${name}`, { email });
    const result = await emailService.provisionEmailWithRetry(id, name);
    logger.success(`Email provisioned: ${result.email}`, { attempts: result.attempts });
    res.json({ success: true, email: result.email, attempts: result.attempts });
  } catch (error) {
    logger.error(`Email provisioning failed`, { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/provision/email/batch
 * Batch email provisioning with auto-retry for duplicates
 */
router.post('/provision/email/batch', async (req, res) => {
  const { users } = req.body;

  if (!users || !Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ success: false, error: 'users array is required' });
  }

  logger.info(`Batch email provisioning for ${users.length} users`);

  const results = [];
  let successful = 0;

  for (const user of users) {
    try {
      logger.info(`Provisioning email for ${user.name}`);
      const result = await emailService.provisionEmailWithRetry(user.id, user.name);
      results.push({ 
        id: user.id, 
        name: user.name, 
        success: true, 
        email: result.email,
        attempts: result.attempts
      });
      successful++;
      logger.success(`Email provisioned for ${user.name}: ${result.email}`, { attempts: result.attempts });
    } catch (error) {
      results.push({ id: user.id, name: user.name, success: false, error: error.message });
      logger.error(`Email failed for ${user.name}`, { error: error.message });
    }
  }

  res.json({
    success: true,
    data: results,
    summary: { total: users.length, successful, failed: users.length - successful }
  });
});

/**
 * POST /api/provision/didi
 * Single Didi account provisioning
 */
router.post('/provision/didi', async (req, res) => {
  const { name, phone, didi_rule_id } = req.body;

  if (!name || !phone || !didi_rule_id) {
    return res.status(400).json({ success: false, error: 'name, phone, and didi_rule_id are required' });
  }

  try {
    logger.info(`Provisioning Didi for ${name}`, { phone, ruleId: didi_rule_id });
    const result = await didiService.addMember(name, phone, [didi_rule_id]);
    logger.success(`Didi account created for ${name}`);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(`Didi provisioning failed for ${name}`, { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/provision/didi/batch
 * Batch Didi account provisioning
 */
router.post('/provision/didi/batch', async (req, res) => {
  const { users } = req.body;

  if (!users || !Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ success: false, error: 'users array is required' });
  }

  logger.info(`Batch Didi provisioning for ${users.length} users`);

  const results = [];
  let successful = 0;

  for (const user of users) {
    try {
      logger.info(`Provisioning Didi for ${user.name}`, { phone: user.phone });
      const result = await didiService.addMember(user.name, user.phone, [user.didi_rule_id]);
      results.push({ name: user.name, success: true, ...result });
      successful++;
      logger.success(`Didi account created for ${user.name}`);
    } catch (error) {
      results.push({ name: user.name, success: false, error: error.message });
      logger.error(`Didi failed for ${user.name}`, { error: error.message });
    }
  }

  res.json({
    success: true,
    data: results,
    summary: { total: users.length, successful, failed: users.length - successful }
  });
});

/**
 * GET /api/logs/stream
 * SSE Endpoint for real-time log streaming
 */
router.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const recentLogs = logger.getRecentLogs(50);
  recentLogs.forEach(log => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });

  const onLog = (log) => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  };

  logger.on('log', onLog);

  req.on('close', () => {
    logger.off('log', onLog);
  });
});

/**
 * GET /api/health
 */
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
