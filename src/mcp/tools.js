import { feishuService } from '../services/feishu.js';
import { didiService } from '../services/didi.js';
import { emailService } from '../services/email.js';
import { matcherService } from '../services/matcher.js';
import { logger } from '../services/logger.js';

/**
 * MCP Tool: list_hires
 * 列出待入职/已入职人员，支持按城市、日期、状态过滤
 */
export async function listHires({ location, date, status } = {}) {
  try {
    const queryStatus = status || 'preboarding';
    logger.info('MCP: Fetching pre-hires', { location, date, status: queryStatus });

    const preHires = await feishuService.getEnrichedPreHires(queryStatus);
    const withEmails = emailService.batchGenerateEmailsLocal(preHires);

    let enriched = withEmails;

    // 匹配滴滴制度
    if (didiService.configured) {
      try {
        const didiRules = await didiService.fetchRegulations();
        enriched = matcherService.batchMatchRules(withEmails, didiRules);
      } catch (err) {
        logger.warn('MCP: 获取滴滴规则失败', { error: err.message });
      }
    }

    // 过滤
    if (location) {
      const normalizedLocation = location.toLowerCase();
      enriched = enriched.filter(h =>
        h.city?.toLowerCase().includes(normalizedLocation)
      );
    }

    if (date) {
      enriched = enriched.filter(h => h.onboardingDate === date);
    }

    logger.success(`MCP: Found ${enriched.length} pre-hires`);

    return {
      success: true,
      total: enriched.length,
      filters: { location, date, status: queryStatus },
      data: enriched.map(h => ({
        id: h.id,
        name: h.name,
        phone: h.phone,
        city: h.city,
        department_id: h.departmentId,
        employee_type: h.employeeType,
        is_intern: h.isIntern,
        onboarding_date: h.onboardingDate,
        suggested_email: h.suggested_email,
        email_task_status: h.emailTaskStatus,
        suggested_didi_rule_id: h.suggested_didi_rule_id,
        suggested_didi_rule_name: h.suggested_didi_rule_name
      }))
    };
  } catch (error) {
    logger.error('MCP: Failed to list hires', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * MCP Tool: provision_email
 * 为单个员工开通工作邮箱
 */
export async function provisionEmail({ id, name, email }) {
  try {
    logger.info(`MCP: 开通邮箱 ${name}`, { id, email });
    const result = await emailService.provisionEmailWithRetry(id, name, email || null);
    logger.success(`MCP: 邮箱开通成功 ${name} -> ${result.email}`);
    return {
      success: true,
      name,
      email: result.email,
      attempts: result.attempts
    };
  } catch (error) {
    logger.error(`MCP: 邮箱开通失败 ${name}`, { error: error.message });
    return { success: false, name, error: error.message };
  }
}

/**
 * MCP Tool: provision_email_batch
 * 批量开通工作邮箱
 */
export async function provisionEmailBatch({ users }) {
  if (!users || users.length === 0) {
    return { success: false, error: 'users 数组不能为空' };
  }

  logger.info(`MCP: 批量开通邮箱 ${users.length} 人`);
  const results = [];
  let successful = 0;

  for (const user of users) {
    try {
      const result = await emailService.provisionEmailWithRetry(user.id, user.name, user.email || null);
      results.push({ name: user.name, success: true, email: result.email, attempts: result.attempts });
      successful++;
      logger.success(`MCP: ${user.name} -> ${result.email}`);
    } catch (error) {
      results.push({ name: user.name, success: false, error: error.message });
      logger.error(`MCP: ${user.name} 失败`, { error: error.message });
    }
  }

  return {
    success: true,
    summary: { total: users.length, successful, failed: users.length - successful },
    data: results
  };
}

/**
 * MCP Tool: provision_didi
 * 为单个员工开通滴滴企业账号
 */
export async function provisionDidi({ name, phone, didi_rule_id, email, residentsname }) {
  try {
    if (!didiService.configured) {
      return { success: false, error: '滴滴企业版未配置' };
    }
    logger.info(`MCP: 开通滴滴 ${name}`, { phone, didi_rule_id });
    const result = await didiService.provisionMember(name, phone, didi_rule_id || null, {
      email, residentsname
    });
    logger.success(`MCP: 滴滴开通 ${name}`, result);
    return { success: true, name, ...result };
  } catch (error) {
    logger.error(`MCP: 滴滴开通失败 ${name}`, { error: error.message });
    return { success: false, name, error: error.message };
  }
}

/**
 * MCP Tool: get_didi_rules
 * 获取所有滴滴用车规则
 */
export async function getDidiRules() {
  try {
    const rules = await didiService.fetchRegulations();
    return { success: true, total: rules.length, data: rules };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * MCP Tool: send_bot_notification
 * 手动触发机器人通知（检查新入职人员并推送卡片）
 */
export async function sendBotNotification({ type }) {
  try {
    const { botService } = await import('../services/bot.js');
    if (!botService.enabled) {
      return { success: false, error: '飞书机器人未配置' };
    }

    if (type === 'summary') {
      await botService.sendDailySummary();
      return { success: true, message: '每日汇总已发送' };
    } else {
      await botService.checkAndNotify();
      return { success: true, message: '检查并通知完成' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * MCP Tool: get_audit_log
 * 获取操作审计日志
 */
export async function getAuditLog({ count }) {
  try {
    const { botService } = await import('../services/bot.js');
    const logs = botService.getAuditLog(count || 20);
    return { success: true, total: logs.length, data: logs };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== Tool Definitions ====================

export const toolDefinitions = [
  {
    name: 'list_hires',
    description: '列出待入职/已入职人员。返回姓名、城市、入职日期、建议邮箱、滴滴规则等信息。默认只显示需要开通邮箱的 preboarding 人员。',
    inputSchema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: '按城市过滤（如 "北京"、"武汉"）'
        },
        date: {
          type: 'string',
          description: '按入职日期过滤（YYYY-MM-DD 格式）'
        },
        status: {
          type: 'string',
          description: '状态: preboarding（待入职，默认）或 completed（已入职）',
          enum: ['preboarding', 'completed']
        }
      }
    }
  },
  {
    name: 'provision_email',
    description: '为单个员工开通飞书工作邮箱。会自动检查重复并使用备选邮箱。需要提供 pre_hire_id 和中文姓名。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '飞书 pre_hire_id' },
        name: { type: 'string', description: '员工中文姓名' },
        email: { type: 'string', description: '指定邮箱（可选，不填则自动生成拼音邮箱）' }
      },
      required: ['id', 'name']
    }
  },
  {
    name: 'provision_email_batch',
    description: '批量为多个员工开通飞书工作邮箱。每个用户需要 id 和 name，email 可选。',
    inputSchema: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          description: '用户列表',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '飞书 pre_hire_id' },
              name: { type: 'string', description: '员工中文姓名' },
              email: { type: 'string', description: '指定邮箱（可选）' }
            },
            required: ['id', 'name']
          }
        }
      },
      required: ['users']
    }
  },
  {
    name: 'provision_didi',
    description: '为员工开通企业滴滴账号。需要姓名、手机号和用车规则ID。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '员工姓名' },
        phone: { type: 'string', description: '手机号（不含+86）' },
        didi_rule_id: { type: 'string', description: '滴滴用车规则 ID' }
      },
      required: ['name', 'phone', 'didi_rule_id']
    }
  },
  {
    name: 'get_didi_rules',
    description: '获取所有可用的滴滴企业用车规则列表。',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'send_bot_notification',
    description: '手动触发飞书机器人通知。type=check 检查新入职人员并推送，type=summary 发送每日汇总。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '通知类型: check（检查新人员）或 summary（每日汇总）',
          enum: ['check', 'summary']
        }
      }
    }
  },
  {
    name: 'get_audit_log',
    description: '获取最近的操作审计日志，包括邮箱开通记录、操作人等。',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '返回条数（默认20）' }
      }
    }
  }
];
