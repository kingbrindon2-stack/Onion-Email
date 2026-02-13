import express from 'express';
import { feishuService, INTERN_TYPE_ID } from '../services/feishu.js';
import { didiService } from '../services/didi.js';
import { emailService } from '../services/email.js';
import { matcherService } from '../services/matcher.js';
import { logger } from '../services/logger.js';
import { botService } from '../services/bot.js';

const router = express.Router();

// Cache for Didi rules
let didiRulesCache = { rules: [], expiresAt: 0 };
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟缓存

async function getDidiRules() {
  if (!didiService.configured) {
    return [];
  }
  if (didiRulesCache.rules.length && Date.now() < didiRulesCache.expiresAt) {
    return didiRulesCache.rules;
  }
  try {
    const rules = await didiService.fetchRegulations();
    didiRulesCache = { rules, expiresAt: Date.now() + CACHE_TTL };
    logger.info(`Didi: 获取到 ${rules.length} 条用车制度`);
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
 * 
 * 性能优化：邮箱生成使用纯本地拼音计算，不调飞书 API
 */
router.get('/hires', async (req, res) => {
  try {
    const status = req.query.status || 'preboarding';
    const showAll = req.query.all === 'true';
    logger.info(`Fetching ${status} hires (showAll: ${showAll})`);

    const preHires = await feishuService.getEnrichedPreHires(status, showAll);
    logger.info(`Found ${preHires.length} ${status} hires`);

    // 本地生成建议邮箱（纯拼音计算，无 API 调用，同批自动去重）
    const withEmails = emailService.batchGenerateEmailsLocal(preHires);

    // 匹配滴滴用车制度（为每个人建议制度）
    let enriched = withEmails;
    try {
      const didiRules = await getDidiRules();
      if (didiRules.length > 0) {
        enriched = matcherService.batchMatchRules(withEmails, didiRules);
      }
    } catch (err) {
      logger.warn('Didi rules matching skipped', { error: err.message });
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
 * 支持前端传入指定邮箱，开通时才做真正的去重检查
 */
router.post('/provision/email', async (req, res) => {
  const { id, name, email } = req.body;

  if (!id || !name) {
    return res.status(400).json({ success: false, error: 'id and name are required' });
  }

  try {
    logger.info(`Provisioning email for ${name}`, { preferredEmail: email });
    const result = await emailService.provisionEmailWithRetry(id, name, email || null);
    logger.success(`Email provisioned: ${result.email}`, { attempts: result.attempts });
    res.json({ success: true, email: result.email, attempts: result.attempts });
  } catch (error) {
    logger.error(`Email provisioning failed for ${name}`, { error: error.message });
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
      const result = await emailService.provisionEmailWithRetry(user.id, user.name, user.email || null);
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
 * 开通单人滴滴账号
 * 
 * Body: { name, phone, didi_rule_id?, email?, residentsname? }
 */
router.post('/provision/didi', async (req, res) => {
  const { name, phone, didi_rule_id, email, residentsname, employeeTypeId } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ success: false, error: 'name 和 phone 是必填字段' });
  }

  if (!didiService.configured) {
    return res.status(400).json({ success: false, error: '滴滴企业版未配置' });
  }

  // 实习生不开通企业滴滴
  if (employeeTypeId === INTERN_TYPE_ID) {
    return res.status(400).json({ success: false, error: '实习生默认不开通企业滴滴' });
  }

  try {
    logger.info(`Provisioning Didi for ${name}`, { phone, ruleId: didi_rule_id });
    const result = await didiService.provisionMember(name, phone, didi_rule_id || null, {
      email,
      residentsname
    });
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(`Didi provisioning failed for ${name}`, { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/provision/didi/batch
 * 批量开通滴滴账号
 * 
 * Body: { users: [{ name, phone, didi_rule_id?, email?, residentsname? }] }
 */
router.post('/provision/didi/batch', async (req, res) => {
  const { users } = req.body;

  if (!users || !Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ success: false, error: 'users array is required' });
  }

  if (!didiService.configured) {
    return res.status(400).json({ success: false, error: '滴滴企业版未配置' });
  }

  logger.info(`Batch Didi provisioning for ${users.length} users`);

  const results = [];
  let successful = 0;

  for (const user of users) {
    try {
      logger.info(`Provisioning Didi for ${user.name}`, { phone: user.phone });
      const result = await didiService.provisionMember(
        user.name,
        user.phone,
        user.didi_rule_id || null,
        { email: user.email, residentsname: user.residentsname }
      );
      results.push({ name: user.name, success: true, ...result });
      if (result.success) successful++;
      logger.success(`Didi provisioned for ${user.name}`);
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

  // 发送心跳防止连接超时
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  const recentLogs = logger.getRecentLogs(50);
  recentLogs.forEach(log => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });

  const onLog = (log) => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  };

  logger.on('log', onLog);

  req.on('close', () => {
    clearInterval(heartbeat);
    logger.off('log', onLog);
  });
});

/**
 * POST /api/bot/check
 * 手动触发机器人检查（也可用于测试）
 */
router.post('/bot/check', async (req, res) => {
  try {
    if (!botService.enabled) {
      return res.status(400).json({ 
        success: false, 
        error: '飞书机器人未配置，请设置 FEISHU_BOT_CHAT_ID 或 FEISHU_BOT_WEBHOOK 环境变量' 
      });
    }
    // 手动触发默认 force=true，绕过去重逻辑
    const force = req.body.force !== false;
    const result = await botService.checkAndNotify(force);
    res.json({ success: true, message: '检查并通知完成', ...result });
  } catch (error) {
    logger.error('Manual bot check failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/bot/summary
 * 手动触发每日汇总
 */
router.post('/bot/summary', async (req, res) => {
  try {
    if (!botService.enabled) {
      return res.status(400).json({ success: false, error: '飞书机器人未配置' });
    }
    await botService.sendDailySummary();
    res.json({ success: true, message: '每日汇总已发送' });
  } catch (error) {
    logger.error('Manual summary failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/bot/audit
 * 获取操作审计日志
 */
router.get('/bot/audit', (req, res) => {
  const count = parseInt(req.query.count || '50', 10);
  const logs = botService.getAuditLog(count);
  res.json({ success: true, data: logs, total: logs.length });
});

/**
 * POST /api/bot/callback
 * 飞书消息卡片回调接口
 * 需要在飞书开放平台配置此地址作为消息卡片请求网址
 */
router.post('/bot/callback', async (req, res) => {
  try {
    const body = req.body;

    // 飞书 URL 验证（配置回调地址时的验证请求）
    if (body.type === 'url_verification') {
      return res.json({ challenge: body.challenge });
    }

    logger.info('Bot callback received', { 
      open_id: body.open_id,
      action_tag: body.action?.tag,
      has_action: !!body.action 
    });

    // 飞书卡片回调结构：
    // body.open_id / body.user_id = 操作人
    // body.open_message_id = 消息 ID
    // body.action.value = 按钮携带的值
    // body.action.tag = 组件类型
    const action = {
      ...(body.action || {}),
      operator: {
        open_id: body.open_id,
        user_id: body.user_id,
        tenant_key: body.tenant_key
      }
    };

    const result = await botService.handleCardCallback(action);
    res.json(result);
  } catch (error) {
    logger.error('Bot callback error', { error: error.message, body: JSON.stringify(req.body).slice(0, 500) });
    res.status(200).json({ 
      toast: { type: 'error', content: '处理失败: ' + error.message } 
    });
  }
});

/**
 * GET /api/bot/chats
 * 获取机器人所在的群聊列表（用于找到 Chat ID）
 */
router.get('/bot/chats', async (req, res) => {
  try {
    const result = await feishuService.request('GET', '/im/v1/chats', null, {
      page_size: 50
    });
    if (result.code !== 0) {
      return res.status(500).json({ success: false, error: result.msg });
    }
    const chats = (result.data?.items || []).map(chat => ({
      chat_id: chat.chat_id,
      name: chat.name,
      description: chat.description || '',
      owner_id: chat.owner_id,
      chat_mode: chat.chat_mode,
      member_count: chat.user_count
    }));
    res.json({ success: true, data: chats, total: chats.length });
  } catch (error) {
    logger.error('Failed to fetch bot chats', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/bot/config
 * 动态配置机器人 Chat ID（写入环境变量，运行时生效）
 */
router.post('/bot/config', async (req, res) => {
  const { chat_id } = req.body;
  if (!chat_id) {
    return res.status(400).json({ success: false, error: 'chat_id is required' });
  }
  process.env.FEISHU_BOT_CHAT_ID = chat_id;
  logger.info(`Bot: Chat ID 已更新为 ${chat_id}`);

  // 如果 bot 之前没启动，现在启动
  if (!botService.timer && botService.enabled) {
    botService.start();
  }

  res.json({ success: true, message: `Chat ID 已设置为 ${chat_id}`, bot_enabled: botService.enabled });
});

/**
 * GET /api/health
 */
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    bot_enabled: botService.enabled,
    bot_chat_id: botService.chatId || null,
    didi_configured: didiService.configured
  });
});

export default router;
