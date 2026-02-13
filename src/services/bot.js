import { feishuService } from './feishu.js';
import { emailService } from './email.js';
import { didiService } from './didi.js';
import { matcherService } from './matcher.js';
import { logger } from './logger.js';

/**
 * 飞书机器人服务 - 入职自动化的主要交互入口
 * 
 * 核心功能：
 * 1. 定时检查新的待入职人员，推送智能通知卡片（含邮箱+滴滴）
 * 2. 按城市区分推送频率：北京周一/三，武汉有新人即推
 * 3. 卡片交互：一键开通邮箱/滴滴，无需打开网页
 * 4. 实习生自动标记，不展示滴滴开通按钮
 * 5. 滴滴开通仅对 completed 状态的非实习员工
 * 6. 每日汇总 + 入职倒计时提醒
 */

// 城市推送策略
const CITY_PUSH_RULES = {
  '北京': { type: 'scheduled', days: [1, 3] },   // 周一=1, 周三=3
  '武汉': { type: 'realtime' },                    // 有新人即推
};
const DEFAULT_PUSH_RULE = { type: 'scheduled', days: [1, 3] }; // 默认跟北京

class BotService {
  constructor() {
    this.timer = null;
    this.dailyTimer = null;
    this.lastKnownIds = new Set();
    this.lastKnownCompletedIds = new Set();
    this.initialized = false;
    this.completedInitialized = false;
    // 记录已发送的消息 ID，用于后续更新卡片
    this.sentMessages = new Map(); // messageId -> { hires, timestamp }
    // 操作审计日志
    this.auditLog = [];
  }

  get chatId() {
    return process.env.FEISHU_BOT_CHAT_ID;
  }

  get webhookUrl() {
    return process.env.FEISHU_BOT_WEBHOOK;
  }

  get checkInterval() {
    return parseInt(process.env.BOT_CHECK_INTERVAL || '1800000', 10);
  }

  get enabled() {
    return !!(this.chatId || this.webhookUrl);
  }

  // ==================== 生命周期 ====================

  start() {
    if (!this.enabled) {
      logger.info('Bot: 未配置飞书机器人（FEISHU_BOT_CHAT_ID 或 FEISHU_BOT_WEBHOOK），跳过启动');
      return;
    }

    logger.info(`Bot: 启动定时检查，间隔 ${this.checkInterval / 1000}s`);

    // 首次延迟 10 秒执行
    setTimeout(() => this.checkAndNotify(), 10000);

    // 定时检查
    this.timer = setInterval(() => this.checkAndNotify(), this.checkInterval);

    // 每日汇总（每天早上 9:00）
    this._scheduleDailySummary();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer);
      this.dailyTimer = null;
    }
    logger.info('Bot: 已停止');
  }

  // ==================== 城市推送策略 ====================

  /**
   * 判断某个城市当前是否应该推送
   * @param {string} city - 城市名
   * @param {boolean} hasNewHires - 是否有新增人员
   * @returns {boolean}
   */
  _shouldPushForCity(city, hasNewHires) {
    const rule = CITY_PUSH_RULES[city] || DEFAULT_PUSH_RULE;

    if (rule.type === 'realtime') {
      // 实时推送：只要有新人就推
      return hasNewHires;
    }

    if (rule.type === 'scheduled') {
      // 定时推送：只在指定的星期几推送
      const now = new Date();
      // 使用中国时区的星期几
      const chinaDay = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getDay();
      return rule.days.includes(chinaDay);
    }

    return hasNewHires; // 默认有新人就推
  }

  /**
   * 获取城市推送规则的可读描述
   */
  _getCityPushDescription(city) {
    const rule = CITY_PUSH_RULES[city] || DEFAULT_PUSH_RULE;
    if (rule.type === 'realtime') return '有新人即推送';
    if (rule.type === 'scheduled') {
      const dayNames = { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' };
      const days = rule.days.map(d => dayNames[d]).join('/');
      return `每${days}推送`;
    }
    return '默认';
  }

  // ==================== 定时检查 ====================

  async checkAndNotify(force = false) {
    try {
      logger.info('Bot: 开始检查待入职人员...');

      // 并行获取 preboarding（邮箱）和 completed（滴滴）
      const [preHires, completedHires] = await Promise.all([
        feishuService.getEnrichedPreHires('preboarding', false),
        didiService.configured ? feishuService.getEnrichedPreHires('completed', false) : Promise.resolve([])
      ]);

      // ===== 处理 preboarding（邮箱开通） =====
      let emailResults = { sent: false, count: 0 };
      if (preHires.length > 0) {
        emailResults = await this._processPreboardingHires(preHires, force);
      } else {
        logger.info('Bot: 没有需要处理的待入职人员（邮箱）');
      }

      // ===== 处理 completed（滴滴开通） =====
      let didiResults = { sent: false, count: 0 };
      if (completedHires.length > 0 && didiService.configured) {
        didiResults = await this._processCompletedHires(completedHires, force);
      }

      const totalSent = (emailResults.sent ? emailResults.count : 0) + (didiResults.sent ? didiResults.count : 0);
      return { 
        sent: emailResults.sent || didiResults.sent, 
        count: totalSent,
        email: emailResults,
        didi: didiResults
      };

    } catch (error) {
      logger.error('Bot: 检查/通知失败', { error: error.message });
      return { sent: false, reason: 'error', error: error.message };
    }
  }

  /**
   * 处理 preboarding 人员 - 邮箱开通通知
   * 按城市分组，根据推送策略决定是否发送
   */
  async _processPreboardingHires(preHires, force) {
    // 识别新增
    let newHires;
    if (force) {
      newHires = preHires;
      logger.info(`Bot: 强制模式，发送全部 ${preHires.length} 人（邮箱）`);
    } else {
      newHires = this.initialized
        ? preHires.filter(h => !this.lastKnownIds.has(h.id))
        : preHires;
    }

    this.lastKnownIds = new Set(preHires.map(h => h.id));
    this.initialized = true;

    if (newHires.length === 0 && !force) {
      logger.info('Bot: 没有新增的待入职人员（邮箱）');
      return { sent: false, reason: 'no_new_hires', count: 0 };
    }

    // 生成建议邮箱
    const withEmails = emailService.batchGenerateEmailsLocal(force ? preHires : newHires);

    // 按城市分组
    const byCity = {};
    withEmails.forEach(h => {
      const city = h.city || 'Unknown';
      if (!byCity[city]) byCity[city] = [];
      byCity[city].push(h);
    });

    let totalSent = 0;

    for (const [city, cityHires] of Object.entries(byCity)) {
      const hasNewInCity = cityHires.some(h => !this.lastKnownIds.has(h.id)) || force;

      if (!this._shouldPushForCity(city, hasNewInCity) && !force) {
        logger.info(`Bot: ${city} 今天不推送（规则: ${this._getCityPushDescription(city)}），跳过 ${cityHires.length} 人`);
        continue;
      }

      logger.info(`Bot: ${city} ${cityHires.length} 名待处理人员，发送邮箱通知...`);
      await this._sendEmailCard(cityHires, city);
      totalSent += cityHires.length;
    }

    if (totalSent > 0) {
      logger.success(`Bot: 邮箱通知发送完成，共 ${totalSent} 人`);
    }

    return { sent: totalSent > 0, count: totalSent };
  }

  /**
   * 处理 completed 人员 - 滴滴开通通知
   * 仅非实习生，按城市推送策略
   */
  async _processCompletedHires(completedHires, force) {
    // 过滤实习生
    const nonInterns = completedHires.filter(h => !h.isIntern);
    if (nonInterns.length === 0) {
      logger.info('Bot: completed 人员全是实习生，无需开通滴滴');
      return { sent: false, reason: 'all_interns', count: 0 };
    }

    // 识别新增
    let newCompleted;
    if (force) {
      newCompleted = nonInterns;
      logger.info(`Bot: 强制模式，发送全部 ${nonInterns.length} 人（滴滴）`);
    } else {
      newCompleted = this.completedInitialized
        ? nonInterns.filter(h => !this.lastKnownCompletedIds.has(h.id))
        : nonInterns;
    }

    this.lastKnownCompletedIds = new Set(nonInterns.map(h => h.id));
    this.completedInitialized = true;

    if (newCompleted.length === 0 && !force) {
      logger.info('Bot: 没有新增 completed 人员需要开通滴滴');
      return { sent: false, reason: 'no_new_completed', count: 0 };
    }

    // 匹配滴滴规则
    let enriched = newCompleted;
    try {
      const didiRules = await didiService.fetchRegulations();
      enriched = matcherService.batchMatchRules(newCompleted, didiRules);
    } catch (err) {
      logger.warn('Bot: 获取滴滴规则失败，跳过匹配', { error: err.message });
    }

    // 按城市分组
    const byCity = {};
    enriched.forEach(h => {
      const city = h.city || 'Unknown';
      if (!byCity[city]) byCity[city] = [];
      byCity[city].push(h);
    });

    let totalSent = 0;

    for (const [city, cityHires] of Object.entries(byCity)) {
      const hasNew = cityHires.some(h => !this.lastKnownCompletedIds.has(h.id)) || force;

      if (!this._shouldPushForCity(city, hasNew) && !force) {
        logger.info(`Bot: ${city} 今天不推送滴滴通知（规则: ${this._getCityPushDescription(city)}），跳过 ${cityHires.length} 人`);
        continue;
      }

      logger.info(`Bot: ${city} ${cityHires.length} 名已入职员工，发送滴滴通知...`);
      await this._sendDidiCard(cityHires, city);
      totalSent += cityHires.length;
    }

    if (totalSent > 0) {
      logger.success(`Bot: 滴滴通知发送完成，共 ${totalSent} 人`);
    }

    return { sent: totalSent > 0, count: totalSent };
  }

  // ==================== 每日汇总 ====================

  _scheduleDailySummary() {
    const now = new Date();
    const target = new Date();
    target.setHours(9, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);

    const delay = target.getTime() - now.getTime();
    logger.info(`Bot: 每日汇总将在 ${target.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 发送`);

    this.dailyTimer = setTimeout(() => {
      this.sendDailySummary();
      // 设置每 24 小时重复
      this.dailyTimer = setInterval(() => this.sendDailySummary(), 24 * 60 * 60 * 1000);
    }, delay);
  }

  async sendDailySummary() {
    try {
      logger.info('Bot: 发送每日汇总...');
      const preHires = await feishuService.getEnrichedPreHires('preboarding', false);

      if (preHires.length === 0) {
        await this._sendCard(this._buildSimpleCard(
          '📊 每日入职汇总',
          '✅ 当前没有待处理的入职人员，一切就绪！',
          'green'
        ));
        return;
      }

      const withEmails = emailService.batchGenerateEmailsLocal(preHires);

      // 按紧急程度分组
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

      const urgent = withEmails.filter(h => h.onboardingDate && h.onboardingDate <= today);
      const soon = withEmails.filter(h => h.onboardingDate && h.onboardingDate > today && h.onboardingDate <= tomorrow);
      const thisWeek = withEmails.filter(h => h.onboardingDate && h.onboardingDate > tomorrow && h.onboardingDate <= nextWeek);
      const later = withEmails.filter(h => !h.onboardingDate || h.onboardingDate > nextWeek);

      const card = this._buildDailySummaryCard({ urgent, soon, thisWeek, later, total: withEmails.length });
      await this._sendCard(card);
      logger.success('Bot: 每日汇总发送成功');

    } catch (error) {
      logger.error('Bot: 每日汇总失败', { error: error.message });
    }
  }

  // ==================== 发送卡片 ====================

  async _sendEmailCard(hires, city) {
    const card = this._buildEmailCard(hires, city);
    const messageId = await this._sendCard(card);
    this._trackMessage(messageId, hires);
  }

  async _sendDidiCard(hires, city) {
    const card = this._buildDidiCard(hires, city);
    const messageId = await this._sendCard(card);
    this._trackMessage(messageId, hires);
  }

  // legacy method for refresh callback
  async sendNewHiresCard(hires) {
    const card = this._buildEmailCard(hires);
    const messageId = await this._sendCard(card);
    this._trackMessage(messageId, hires);
  }

  _trackMessage(messageId, hires) {
    if (messageId) {
      this.sentMessages.set(messageId, {
        hires: hires.map(h => ({ ...h, status: 'pending' })),
        timestamp: Date.now()
      });
      if (this.sentMessages.size > 50) {
        const oldest = this.sentMessages.keys().next().value;
        this.sentMessages.delete(oldest);
      }
    }
  }

  async _sendCard(card) {
    if (!this.chatId) {
      if (this.webhookUrl) {
        await feishuService.sendBotMessage(this.webhookUrl, { msg_type: 'interactive', card });
        return null;
      }
      return null;
    }

    const result = await feishuService.sendMessageToChat(this.chatId, 'interactive', card);
    return result?.data?.message_id || null;
  }

  // ==================== 卡片构建 ====================

  /**
   * 邮箱开通通知卡片（preboarding 阶段）
   * 只展示邮箱相关操作，不含滴滴
   */
  _buildEmailCard(hires, city = null) {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const today = new Date().toISOString().slice(0, 10);
    const cityLabel = city ? ` · ${city}` : '';
    const pushRule = city ? this._getCityPushDescription(city) : '';

    // 按入职日期分组
    const grouped = {};
    hires.forEach(h => {
      const date = h.onboardingDate || '未知日期';
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(h);
    });

    const elements = [];

    // 总览
    const overview = [`共 **${hires.length}** 名待入职人员需要开通邮箱`];
    if (pushRule) overview.push(`推送规则: ${pushRule}`);
    elements.push({ tag: 'markdown', content: overview.join('\n') });
    elements.push({ tag: 'hr' });

    // 按日期分组展示
    for (const [date, users] of Object.entries(grouped).sort()) {
      let dateLabel = `📅 ${date}`;
      if (date <= today) {
        dateLabel = `🔴 ${date}（今天或已过期）`;
      } else {
        const daysUntil = Math.ceil((new Date(date) - new Date(today)) / 86400000);
        if (daysUntil <= 1) dateLabel = `🟠 ${date}（明天）`;
        else if (daysUntil <= 3) dateLabel = `🟡 ${date}（${daysUntil}天后）`;
        else dateLabel = `🟢 ${date}（${daysUntil}天后）`;
      }

      elements.push({ tag: 'markdown', content: `**${dateLabel}**` });

      // 人员表格 - 含人员类型
      const rows = users.map(u => {
        const email = u.suggested_email ? u.suggested_email.replace('@guanghe.tv', '') : '-';
        const typeTag = u.isIntern ? '(实习)' : '';
        return `| ${u.name}${typeTag} | ${u.city || '-'} | ${email}@guanghe.tv | ${u.phone || '-'} |`;
      }).join('\n');

      elements.push({
        tag: 'markdown',
        content: `| 姓名 | 城市 | 建议邮箱 | 电话 |\n| --- | --- | --- | --- |\n${rows}`
      });

      // 每个人的开通按钮
      const actions = users.map(u => ({
        tag: 'button',
        text: { tag: 'plain_text', content: `📧 开通 ${u.name}` },
        type: 'primary',
        value: JSON.stringify({
          action: 'provision_email',
          pre_hire_id: u.id,
          name: u.name,
          email: u.suggested_email
        })
      }));

      for (let i = 0; i < actions.length; i += 3) {
        elements.push({ tag: 'action', actions: actions.slice(i, i + 3) });
      }

      elements.push({ tag: 'hr' });
    }

    // 底部：批量操作按钮
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: `⚡ 一键全部开通邮箱 (${hires.length}人)` },
          type: 'danger',
          confirm: {
            title: { tag: 'plain_text', content: '确认批量开通' },
            text: { tag: 'plain_text', content: `将为 ${hires.length} 名员工自动开通工作邮箱，确定继续？` }
          },
          value: JSON.stringify({
            action: 'provision_all_email',
            users: hires.map(h => ({ id: h.id, name: h.name, email: h.suggested_email }))
          })
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🔄 刷新列表' },
          type: 'default',
          value: JSON.stringify({ action: 'refresh' })
        }
      ]
    });

    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `🕐 ${now}${cityLabel} · 点击按钮直接开通，无需打开网页` }]
    });

    return {
      header: {
        title: { tag: 'plain_text', content: `📧 邮箱开通提醒${cityLabel} (${hires.length}人)` },
        template: hires.some(h => h.onboardingDate && h.onboardingDate <= today) ? 'red' : 'blue'
      },
      elements
    };
  }

  /**
   * 滴滴开通通知卡片（completed 阶段，仅非实习生）
   */
  _buildDidiCard(hires, city = null) {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const cityLabel = city ? ` · ${city}` : '';
    const pushRule = city ? this._getCityPushDescription(city) : '';

    const elements = [];

    // 总览
    const overview = [`共 **${hires.length}** 名已入职员工需要开通企业滴滴`];
    if (pushRule) overview.push(`推送规则: ${pushRule}`);
    elements.push({ tag: 'markdown', content: overview.join('\n') });
    elements.push({ tag: 'hr' });

    // 人员表格
    const rows = hires.map(u => {
      const ruleName = u.suggested_didi_rule_name || '未匹配';
      return `| ${u.name} | ${u.city || '-'} | ${u.phone || '-'} | ${ruleName} |`;
    }).join('\n');

    elements.push({
      tag: 'markdown',
      content: `| 姓名 | 城市 | 电话 | 滴滴规则 |\n| --- | --- | --- | --- |\n${rows}`
    });

    // 每个人的开通按钮
    const actions = hires.filter(u => u.suggested_didi_rule_id).map(u => ({
      tag: 'button',
      text: { tag: 'plain_text', content: `🚗 开通 ${u.name}` },
      type: 'primary',
      value: JSON.stringify({
        action: 'provision_didi',
        name: u.name,
        phone: u.phone,
        didi_rule_id: u.suggested_didi_rule_id,
        didi_rule_name: u.suggested_didi_rule_name
      })
    }));

    for (let i = 0; i < actions.length; i += 3) {
      elements.push({ tag: 'action', actions: actions.slice(i, i + 3) });
    }

    elements.push({ tag: 'hr' });

    // 批量开通按钮
    const provisionable = hires.filter(u => u.suggested_didi_rule_id && u.phone);
    if (provisionable.length > 0) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `⚡ 一键全部开通滴滴 (${provisionable.length}人)` },
            type: 'danger',
            confirm: {
              title: { tag: 'plain_text', content: '确认批量开通滴滴' },
              text: { tag: 'plain_text', content: `将为 ${provisionable.length} 名员工开通企业滴滴账号，确定继续？` }
            },
            value: JSON.stringify({
              action: 'provision_all_didi',
              users: provisionable.map(h => ({
                name: h.name,
                phone: h.phone,
                didi_rule_id: h.suggested_didi_rule_id,
                didi_rule_name: h.suggested_didi_rule_name
              }))
            })
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 刷新' },
            type: 'default',
            value: JSON.stringify({ action: 'refresh' })
          }
        ]
      });
    }

    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `🕐 ${now}${cityLabel} · 仅已入职非实习员工` }]
    });

    return {
      header: {
        title: { tag: 'plain_text', content: `🚗 滴滴开通提醒${cityLabel} (${hires.length}人)` },
        template: 'turquoise'
      },
      elements
    };
  }

  /**
   * 每日汇总卡片
   */
  _buildDailySummaryCard({ urgent, soon, thisWeek, later, total }) {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const elements = [];

    const parts = [];
    if (urgent.length > 0) parts.push(`🔴 今天/已过期: **${urgent.length}**`);
    if (soon.length > 0) parts.push(`🟠 明天: **${soon.length}**`);
    if (thisWeek.length > 0) parts.push(`🟡 本周: **${thisWeek.length}**`);
    if (later.length > 0) parts.push(`🟢 稍后: **${later.length}**`);

    elements.push({
      tag: 'markdown',
      content: `待处理总计: **${total}** 人\n${parts.join(' · ')}`
    });

    elements.push({ tag: 'hr' });

    // 紧急的详细列出
    if (urgent.length > 0) {
      elements.push({
        tag: 'markdown',
        content: `**🔴 紧急 - 今天或已过期入职（${urgent.length}人）**`
      });
      const rows = urgent.map(u => {
        const typeTag = u.isIntern ? '(实习)' : '';
        return `| ${u.name}${typeTag} | ${u.city || '-'} | ${u.onboardingDate} | ${u.suggested_email || '-'} |`;
      }).join('\n');
      elements.push({
        tag: 'markdown',
        content: `| 姓名 | 城市 | 入职日期 | 建议邮箱 |\n| --- | --- | --- | --- |\n${rows}`
      });

      const actions = urgent.map(u => ({
        tag: 'button',
        text: { tag: 'plain_text', content: `📧 ${u.name}` },
        type: 'danger',
        value: JSON.stringify({
          action: 'provision_email',
          pre_hire_id: u.id,
          name: u.name,
          email: u.suggested_email
        })
      }));
      for (let i = 0; i < actions.length; i += 3) {
        elements.push({ tag: 'action', actions: actions.slice(i, i + 3) });
      }
      elements.push({ tag: 'hr' });
    }

    if (soon.length > 0) {
      elements.push({
        tag: 'markdown',
        content: `**🟠 明天入职（${soon.length}人）**`
      });
      const rows = soon.map(u => {
        const typeTag = u.isIntern ? '(实习)' : '';
        return `| ${u.name}${typeTag} | ${u.city || '-'} | ${u.suggested_email || '-'} |`;
      }).join('\n');
      elements.push({
        tag: 'markdown',
        content: `| 姓名 | 城市 | 建议邮箱 |\n| --- | --- | --- |\n${rows}`
      });
      elements.push({ tag: 'hr' });
    }

    if (thisWeek.length > 0) {
      const names = thisWeek.map(u => u.name + (u.isIntern ? '(实习)' : '')).join('、');
      elements.push({
        tag: 'markdown',
        content: `**🟡 本周入职（${thisWeek.length}人）**: ${names}`
      });
    }

    if (later.length > 0) {
      const names = later.map(u => u.name + (u.isIntern ? '(实习)' : '')).join('、');
      elements.push({
        tag: 'markdown',
        content: `**🟢 稍后入职（${later.length}人）**: ${names}`
      });
    }

    // 操作按钮
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: `⚡ 一键全部开通邮箱 (${total}人)` },
          type: 'danger',
          confirm: {
            title: { tag: 'plain_text', content: '确认批量开通' },
            text: { tag: 'plain_text', content: `将为 ${total} 名员工自动开通工作邮箱，确定继续？` }
          },
          value: JSON.stringify({
            action: 'provision_all_email',
            users: [...urgent, ...soon, ...thisWeek, ...later].map(h => ({
              id: h.id, name: h.name, email: h.suggested_email
            }))
          })
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🌐 打开入职中心' },
          type: 'default',
          url: process.env.BASE_URL || 'http://localhost:3000'
        }
      ]
    });

    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `📊 每日汇总 · ${now}` }]
    });

    return {
      header: {
        title: { tag: 'plain_text', content: `📊 每日入职汇总 (${total}人待处理)` },
        template: urgent.length > 0 ? 'red' : (soon.length > 0 ? 'orange' : 'blue')
      },
      elements
    };
  }

  /**
   * 简洁卡片（用于无数据或操作结果通知）
   */
  _buildSimpleCard(title, content, template = 'blue') {
    return {
      header: {
        title: { tag: 'plain_text', content: title },
        template
      },
      elements: [
        { tag: 'markdown', content },
        {
          tag: 'note',
          elements: [{
            tag: 'plain_text',
            content: `🕐 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
          }]
        }
      ]
    };
  }

  /**
   * 邮箱开通结果卡片
   */
  _buildEmailProvisionResultCard(results, operatorName = 'IT') {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const elements = [];

    elements.push({
      tag: 'markdown',
      content: `操作人: **${operatorName}** · 总计 **${results.length}** 人 · 成功 **${successful.length}** · 失败 **${failed.length}**`
    });

    elements.push({ tag: 'hr' });

    if (successful.length > 0) {
      const rows = successful.map(r =>
        `| ${r.name} | ✅ ${r.email} | ${r.attempts > 1 ? `重试${r.attempts}次` : '一次成功'} |`
      ).join('\n');
      elements.push({
        tag: 'markdown',
        content: `**✅ 开通成功**\n| 姓名 | 邮箱 | 备注 |\n| --- | --- | --- |\n${rows}`
      });
    }

    if (failed.length > 0) {
      const rows = failed.map(r =>
        `| ${r.name} | ❌ ${r.error} |`
      ).join('\n');
      elements.push({
        tag: 'markdown',
        content: `**❌ 开通失败**\n| 姓名 | 原因 |\n| --- | --- |\n${rows}`
      });
    }

    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `🕐 ${now}` }]
    });

    const template = failed.length > 0 ? (successful.length > 0 ? 'orange' : 'red') : 'green';

    return {
      header: {
        title: {
          tag: 'plain_text',
          content: failed.length === 0
            ? `✅ 邮箱开通完成 (${successful.length}人)`
            : `⚠️ 邮箱开通结果 (成功${successful.length}/失败${failed.length})`
        },
        template
      },
      elements
    };
  }

  /**
   * 滴滴开通结果卡片
   */
  _buildDidiProvisionResultCard(results, operatorName = 'IT') {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const elements = [];

    elements.push({
      tag: 'markdown',
      content: `操作人: **${operatorName}** · 总计 **${results.length}** 人 · 成功 **${successful.length}** · 失败 **${failed.length}**`
    });

    elements.push({ tag: 'hr' });

    if (successful.length > 0) {
      const rows = successful.map(r =>
        `| ${r.name} | ✅ ${r.ruleName || '已开通'} |`
      ).join('\n');
      elements.push({
        tag: 'markdown',
        content: `**✅ 滴滴开通成功**\n| 姓名 | 规则 |\n| --- | --- |\n${rows}`
      });
    }

    if (failed.length > 0) {
      const rows = failed.map(r =>
        `| ${r.name} | ❌ ${r.error} |`
      ).join('\n');
      elements.push({
        tag: 'markdown',
        content: `**❌ 开通失败**\n| 姓名 | 原因 |\n| --- | --- |\n${rows}`
      });
    }

    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `🕐 ${now}` }]
    });

    const template = failed.length > 0 ? (successful.length > 0 ? 'orange' : 'red') : 'green';

    return {
      header: {
        title: {
          tag: 'plain_text',
          content: failed.length === 0
            ? `✅ 滴滴开通完成 (${successful.length}人)`
            : `⚠️ 滴滴开通结果 (成功${successful.length}/失败${failed.length})`
        },
        template
      },
      elements
    };
  }

  // ==================== 卡片回调处理 ====================

  /**
   * 处理飞书消息卡片回调
   */
  async handleCardCallback(action) {
    let actionValue;
    try {
      actionValue = typeof action.value === 'string' ? JSON.parse(action.value) : action.value;
    } catch {
      return { toast: { type: 'info', content: '无效操作' } };
    }

    if (!actionValue || !actionValue.action) {
      return { toast: { type: 'info', content: '无操作' } };
    }

    const operatorId = action.operator?.open_id || action.operator?.user_id || 'unknown';

    switch (actionValue.action) {
      case 'provision_email':
        return await this._handleProvisionEmail(actionValue, operatorId);

      case 'provision_all_email':
        return await this._handleProvisionAllEmail(actionValue, operatorId);

      case 'provision_didi':
        return await this._handleProvisionDidi(actionValue, operatorId);

      case 'provision_all_didi':
        return await this._handleProvisionAllDidi(actionValue, operatorId);

      case 'refresh':
        return await this._handleRefresh();

      default:
        return { toast: { type: 'info', content: '未知操作' } };
    }
  }

  /**
   * 单人开通邮箱
   */
  async _handleProvisionEmail(data, operatorId) {
    const { pre_hire_id, name, email } = data;
    logger.info(`Bot 回调: 开通邮箱 ${name}`, { operator: operatorId });

    try {
      const result = await emailService.provisionEmailWithRetry(pre_hire_id, name, email);

      this._addAudit('provision_email', { name, email: result.email, operatorId, success: true });

      await this._sendCard(this._buildSimpleCard(
        `✅ ${name} 邮箱已开通`,
        `**${name}** 的工作邮箱已开通: **${result.email}**\n\n${result.attempts > 1 ? `⚠️ 原邮箱被占用，自动使用了备选邮箱（尝试了 ${result.attempts} 次）` : '一次开通成功'}`,
        'green'
      ));

      return {
        toast: { type: 'success', content: `✅ ${name} 邮箱已开通: ${result.email}` }
      };
    } catch (error) {
      this._addAudit('provision_email', { name, operatorId, success: false, error: error.message });
      logger.error(`Bot 回调: 开通失败 ${name}`, { error: error.message });

      return {
        toast: { type: 'error', content: `❌ ${name} 开通失败: ${error.message}` }
      };
    }
  }

  /**
   * 批量开通所有邮箱
   */
  async _handleProvisionAllEmail(data, operatorId) {
    const { users } = data;
    if (!users || users.length === 0) {
      return { toast: { type: 'warning', content: '没有需要开通的人员' } };
    }

    logger.info(`Bot 回调: 批量开通 ${users.length} 人邮箱`, { operator: operatorId });

    // 飞书卡片回调需要 3 秒内返回，所以批量操作异步执行
    this._executeBatchEmailProvision(users, operatorId);

    return {
      toast: { type: 'info', content: `⏳ 正在为 ${users.length} 人开通邮箱，完成后会发送结果通知...` }
    };
  }

  /**
   * 单人开通滴滴
   */
  async _handleProvisionDidi(data, operatorId) {
    const { name, phone, didi_rule_id, didi_rule_name } = data;
    logger.info(`Bot 回调: 开通滴滴 ${name}`, { operator: operatorId, phone, ruleId: didi_rule_id });

    if (!didiService.configured) {
      return { toast: { type: 'error', content: '滴滴企业版未配置' } };
    }

    if (!phone) {
      return { toast: { type: 'error', content: `${name} 没有电话号码，无法开通` } };
    }

    try {
      const result = await didiService.provisionMember(name, phone, didi_rule_id || null, {});

      this._addAudit('provision_didi', { name, phone, ruleName: didi_rule_name, operatorId, success: true });

      await this._sendCard(this._buildSimpleCard(
        `✅ ${name} 滴滴已开通`,
        `**${name}** 的企业滴滴已开通\n规则: **${didi_rule_name || '默认'}**\n${result.alreadyExists ? '(该员工之前已存在)' : ''}`,
        'green'
      ));

      return {
        toast: { type: 'success', content: `✅ ${name} 滴滴已开通` }
      };
    } catch (error) {
      this._addAudit('provision_didi', { name, operatorId, success: false, error: error.message });
      logger.error(`Bot 回调: 滴滴开通失败 ${name}`, { error: error.message });

      return {
        toast: { type: 'error', content: `❌ ${name} 滴滴开通失败: ${error.message}` }
      };
    }
  }

  /**
   * 批量开通所有滴滴
   */
  async _handleProvisionAllDidi(data, operatorId) {
    const { users } = data;
    if (!users || users.length === 0) {
      return { toast: { type: 'warning', content: '没有需要开通的人员' } };
    }

    if (!didiService.configured) {
      return { toast: { type: 'error', content: '滴滴企业版未配置' } };
    }

    logger.info(`Bot 回调: 批量开通 ${users.length} 人滴滴`, { operator: operatorId });

    // 异步执行
    this._executeBatchDidiProvision(users, operatorId);

    return {
      toast: { type: 'info', content: `⏳ 正在为 ${users.length} 人开通滴滴，完成后会发送结果通知...` }
    };
  }

  /**
   * 异步执行批量邮箱开通
   */
  async _executeBatchEmailProvision(users, operatorId) {
    const results = [];

    for (const user of users) {
      try {
        logger.info(`Bot 批量开通邮箱: ${user.name}`);
        const result = await emailService.provisionEmailWithRetry(user.id, user.name, user.email || null);
        results.push({
          name: user.name,
          success: true,
          email: result.email,
          attempts: result.attempts
        });
        logger.success(`Bot 批量邮箱成功: ${user.name} -> ${result.email}`);
      } catch (error) {
        results.push({
          name: user.name,
          success: false,
          error: error.message
        });
        logger.error(`Bot 批量邮箱失败: ${user.name}`, { error: error.message });
      }
    }

    this._addAudit('provision_all_email', {
      operatorId,
      total: users.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    });

    try {
      await this._sendCard(this._buildEmailProvisionResultCard(results));
    } catch (error) {
      logger.error('Bot: 发送邮箱结果卡片失败', { error: error.message });
    }
  }

  /**
   * 异步执行批量滴滴开通
   */
  async _executeBatchDidiProvision(users, operatorId) {
    const results = [];

    for (const user of users) {
      try {
        logger.info(`Bot 批量开通滴滴: ${user.name}`);
        const result = await didiService.provisionMember(user.name, user.phone, user.didi_rule_id || null, {});
        results.push({
          name: user.name,
          success: true,
          ruleName: user.didi_rule_name || '',
          alreadyExists: result.alreadyExists
        });
        logger.success(`Bot 批量滴滴成功: ${user.name}`);
      } catch (error) {
        results.push({
          name: user.name,
          success: false,
          error: error.message
        });
        logger.error(`Bot 批量滴滴失败: ${user.name}`, { error: error.message });
      }
    }

    this._addAudit('provision_all_didi', {
      operatorId,
      total: users.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    });

    try {
      await this._sendCard(this._buildDidiProvisionResultCard(results));
    } catch (error) {
      logger.error('Bot: 发送滴滴结果卡片失败', { error: error.message });
    }
  }

  /**
   * 刷新列表
   */
  async _handleRefresh() {
    logger.info('Bot 回调: 刷新列表');

    try {
      const preHires = await feishuService.getEnrichedPreHires('preboarding', false);

      if (preHires.length === 0) {
        await this._sendCard(this._buildSimpleCard(
          '✅ 全部已处理',
          '当前没有需要开通邮箱的待入职人员',
          'green'
        ));
        return { toast: { type: 'success', content: '已刷新，没有待处理人员' } };
      }

      const withEmails = emailService.batchGenerateEmailsLocal(preHires);
      await this.sendNewHiresCard(withEmails);

      return { toast: { type: 'success', content: `已刷新，${preHires.length} 人待处理` } };
    } catch (error) {
      logger.error('Bot 回调: 刷新失败', { error: error.message });
      return { toast: { type: 'error', content: '刷新失败: ' + error.message } };
    }
  }

  // ==================== 审计日志 ====================

  _addAudit(action, data) {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      action,
      ...data
    });
    if (this.auditLog.length > 200) {
      this.auditLog = this.auditLog.slice(-200);
    }
  }

  getAuditLog(count = 50) {
    return this.auditLog.slice(-count);
  }
}

export const botService = new BotService();
