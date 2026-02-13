import axios from 'axios';

const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

// Location cache with TTL
let locationCache = { data: null, expiresAt: 0 };
const LOCATION_CACHE_TTL = 30 * 60 * 1000; // 30 分钟

// 飞书人员类型枚举映射 (employee_type_id -> 可读名称)
export const EMPLOYEE_TYPE_MAP = {
  '7193602309958436385': '正式',
  '7193602311107724832': '实习',
  '7193602323535480324': '劳务',
  '7193602529916372492': '外包',
  '7193602238470964748': '顾问'
};

export const INTERN_TYPE_ID = '7193602311107724832';

class FeishuService {
  constructor() {
    this.tokenCache = { token: null, expiresAt: 0 };
  }

  get appId() {
    return process.env.FEISHU_APP_ID;
  }

  get appSecret() {
    return process.env.FEISHU_APP_SECRET;
  }

  async getTenantAccessToken() {
    if (this.tokenCache.token && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    const response = await axios.post(`${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
      app_id: this.appId,
      app_secret: this.appSecret
    });

    if (response.data.code !== 0) {
      throw new Error(`Feishu auth failed: ${response.data.msg}`);
    }

    this.tokenCache = {
      token: response.data.tenant_access_token,
      expiresAt: Date.now() + (response.data.expire - 300) * 1000
    };

    return this.tokenCache.token;
  }

  async request(method, path, data = null, params = null, retries = 2) {
    const token = await this.getTenantAccessToken();
    const config = {
      method,
      url: `${FEISHU_BASE_URL}${path}`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000 // 15 秒超时
    };

    if (data) config.data = data;
    if (params) config.params = params;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await axios(config);
        return response.data;
      } catch (err) {
        const status = err.response?.status;
        const code = err.response?.data?.code;

        // 可重试的错误：429(限流)、500/502/503(服务器错误)、网络超时
        const isRetryable = !status || status === 429 || status >= 500 || err.code === 'ECONNABORTED';

        if (isRetryable && attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // 指数退避，最多5秒
          console.warn(`Request failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));

          // 如果是 token 过期，刷新 token
          if (code === 99991663 || code === 99991664) {
            this.tokenCache = { token: null, expiresAt: 0 };
            const newToken = await this.getTenantAccessToken();
            config.headers['Authorization'] = `Bearer ${newToken}`;
          }
          continue;
        }

        console.error('Request error:', err.response?.data?.msg || err.message);
        console.error('Full error response:', JSON.stringify(err.response?.data, null, 2));
        throw err;
      }
    }
  }

  // Build location ID -> city name map (with TTL cache)
  async getLocationMap() {
    if (locationCache.data && Date.now() < locationCache.expiresAt) {
      return locationCache.data;
    }

    const locationMap = {};
    let pageToken = '';

    do {
      const params = { page_size: 100 };
      if (pageToken) params.page_token = pageToken;

      const result = await this.request('GET', '/corehr/v1/locations', null, params);
      
      const items = result.data?.items || [];
      items.forEach(loc => {
        const name = loc.hiberarchy_common?.name?.[0]?.value || 'Unknown';
        locationMap[loc.id] = name;
      });

      pageToken = result.data?.page_token || '';
    } while (pageToken);

    locationCache = { data: locationMap, expiresAt: Date.now() + LOCATION_CACHE_TTL };
    return locationMap;
  }

  async fetchPreHires(status = 'preboarding') {
    const allIds = [];
    let pageToken = '';
    let pageCount = 0;
    // preboarding 取全部，completed 只取前 50 条（最近的）
    const maxPages = status === 'completed' ? 1 : 10;
    const maxCount = status === 'completed' ? 50 : 200;

    do {
      const url = `/corehr/v2/pre_hires/search?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`;
      const result = await this.request('POST', url, {
        onboarding_status: status
      });

      if (result.code !== 0) {
        throw new Error(`Failed to search pre-hires: ${result.msg}`);
      }

      const items = result.data?.items || [];
      items.forEach(item => allIds.push(item.pre_hire_id));
      pageToken = result.data?.page_token || '';
      pageCount++;
      
    } while (pageToken && pageCount < maxPages);

    console.log(`Found ${allIds.length} ${status} pre-hires (${pageCount} pages)`);
    return allIds.slice(0, maxCount);
  }

  async getEnrichedPreHires(status = 'preboarding', showAll = false) {
    const [preHireIds, locationMap] = await Promise.all([
      this.fetchPreHires(status),
      this.getLocationMap()
    ]);

    if (preHireIds.length === 0) {
      console.log('No preboarding pre-hires found');
      return [];
    }

    // 分批查询，每批 10 个，使用并发（最多 3 个并发请求，避免被限流）
    const enrichedItems = [];
    const BATCH_SIZE = 10;
    const CONCURRENCY = 3;
    const batches = [];
    
    for (let i = 0; i < preHireIds.length; i += BATCH_SIZE) {
      batches.push(preHireIds.slice(i, i + BATCH_SIZE));
    }

    // 分组并发执行
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const concurrentBatches = batches.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        concurrentBatches.map(batchIds =>
          this.request('POST', `/corehr/v2/pre_hires/query?page_size=${batchIds.length}`, {
            fields: ['person_info', 'employment_info', 'onboarding_info', 'offer_info'],
            pre_hire_ids: batchIds
          })
        )
      );

      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value.code === 0 && result.value.data?.items) {
          enrichedItems.push(...result.value.data.items);
        }
      });
    }

    console.log(`Enriched ${enrichedItems.length} pre-hires`);

    // 过滤条件
    let filteredItems = enrichedItems;

    // 1. 过滤掉过期的"僵尸"数据：只保留最近 90 天内入职的
    const cutoffDays = status === 'completed' ? 180 : 90;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - cutoffDays);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10); // YYYY-MM-DD

    filteredItems = filteredItems.filter(hire => {
      const onboardingDate = hire.onboarding_info?.onboarding_date;
      if (!onboardingDate) return true; // 没有日期的保留（以防万一）
      return onboardingDate >= cutoffStr;
    });

    console.log(`After date filter (>= ${cutoffStr}): ${filteredItems.length} pre-hires`);

    // 2. preboarding 状态下，过滤掉已开通邮箱的
    if (status === 'preboarding' && !showAll) {
      filteredItems = filteredItems.filter(hire => {
        const taskList = hire.onboarding_info?.onboarding_task_list || [];
        const emailTask = taskList.find(t => t.task_name === 'IT 填写工作邮箱');
        const hasEmail = emailTask && emailTask.task_status === 'completed';
        return !hasEmail;
      });
    }

    console.log(`Filtered to ${filteredItems.length} pre-hires after all filters`);

    return filteredItems.map(hire => {
      const person = hire.person_info || {};
      const employment = hire.employment_info || {};
      const onboarding = hire.onboarding_info || {};
      const offer = hire.offer_info || {};

      const name = person.legal_name || person.preferred_name || '';
      const phone = (person.phone_number || '').replace(/^\+86/, '');
      const locationId = employment.work_location_id;
      const departmentId = employment.department_id;
      const employeeTypeId = employment.employee_type_id || '';
      const onboardingDate = onboarding.onboarding_date;
      const onboardingStatus = onboarding.onboarding_status;
      const workEmail = offer.work_emails?.[0]?.email || '';

      // 获取邮箱任务状态
      const taskList = onboarding.onboarding_task_list || [];
      const emailTask = taskList.find(t => t.task_name === 'IT 填写工作邮箱');
      const emailTaskStatus = emailTask?.task_status || 'unknown';

      const cityName = locationMap[locationId] || 'Unknown';
      const employeeType = EMPLOYEE_TYPE_MAP[employeeTypeId] || '未知';
      const isIntern = employeeTypeId === INTERN_TYPE_ID;

      return {
        id: hire.pre_hire_id,
        name,
        phone,
        city: cityName,
        cityId: locationId,
        departmentId,
        employeeTypeId,
        employeeType,
        isIntern,
        onboardingDate,
        onboardingStatus,
        workEmail,
        emailTaskStatus
      };
    });
  }

  async updateWorkEmail(preHireId, email) {
    console.log('Updating work email for:', preHireId, 'to:', email);
    
    const result = await this.request('PATCH', `/corehr/v2/pre_hires/${preHireId}`, {
      standard_update_fields: ["offer_info_update.work_emails"],
      offer_info_update: {
        work_emails: [{
          email: email,
          is_primary: true,
          is_public: true,
          email_usage: "work"
        }]
      }
    });

    console.log('Update result:', JSON.stringify(result, null, 2));

    // 检查是否是邮箱重复错误（包括离职员工回收站中的邮箱）
    if (result.code === 1119 || result.code === 1161038) {
      return {
        success: false,
        isDuplicate: true,
        code: result.code,
        msg: result.msg
      };
    }

    if (result.code !== 0) {
      throw new Error(`Failed to update work email: ${result.msg}`);
    }

    return {
      success: true,
      data: result
    };
  }

  async checkEmailExists(email) {
    try {
      const result = await this.request('POST', '/contact/v3/users/batch_get_id', {
        emails: [email]
      });
      
      const userList = result.data?.user_list || [];
      return userList.some(u => u.user_id);
    } catch {
      return false;
    }
  }

  /**
   * 发送飞书机器人消息（用于通知 IT）
   * @param {string} webhookUrl - 飞书机器人 Webhook 地址
   * @param {object} msgBody - 消息体
   */
  async sendBotMessage(webhookUrl, msgBody) {
    try {
      const response = await axios.post(webhookUrl, msgBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });
      return response.data;
    } catch (err) {
      console.error('Send bot message error:', err.message);
      throw err;
    }
  }

  /**
   * 通过应用发送消息到指定聊天
   * @param {string} chatId - 群聊 ID
   * @param {string} msgType - 消息类型
   * @param {object} content - 消息内容
   */
  async sendMessageToChat(chatId, msgType, content) {
    const result = await this.request('POST', '/im/v1/messages', {
      receive_id: chatId,
      msg_type: msgType,
      content: typeof content === 'string' ? content : JSON.stringify(content)
    }, { receive_id_type: 'chat_id' });

    if (result.code !== 0) {
      throw new Error(`Failed to send message: ${result.msg}`);
    }
    return result;
  }
}

export const feishuService = new FeishuService();
