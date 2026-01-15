import axios from 'axios';

const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

// Location cache
let locationCache = null;

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

  async request(method, path, data = null, params = null) {
    const token = await this.getTenantAccessToken();
    const config = {
      method,
      url: `${FEISHU_BASE_URL}${path}`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    if (data) config.data = data;
    if (params) config.params = params;

    try {
      const response = await axios(config);
      return response.data;
    } catch (err) {
      console.error('Request error:', err.response?.data?.msg || err.message);
      console.error('Full error response:', JSON.stringify(err.response?.data, null, 2));
      throw err;
    }
  }

  // Build location ID -> city name map
  async getLocationMap() {
    if (locationCache) return locationCache;

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

    locationCache = locationMap;
    return locationMap;
  }

  async fetchPreHires(status = 'preboarding') {
    // 使用 search 接口按状态过滤
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

    // 用 V2 API 批量查询详细信息
    const enrichedItems = [];
    
    // 分批查询，每批 10 个
    for (let i = 0; i < preHireIds.length; i += 10) {
      const batchIds = preHireIds.slice(i, i + 10);
      const result = await this.request('POST', '/corehr/v2/pre_hires/query?page_size=10', {
        fields: ['person_info', 'employment_info', 'onboarding_info', 'offer_info'],
        pre_hire_ids: batchIds
      });
      
      if (result.code === 0 && result.data?.items) {
        enrichedItems.push(...result.data.items);
      }
    }

    console.log(`Enriched ${enrichedItems.length} pre-hires`);

    // 过滤出没有开通邮箱的待入职人员
    // 检查 onboarding_task_list 里 "IT 填写工作邮箱" 任务的状态
    const filteredItems = (status === 'preboarding' && !showAll)
      ? enrichedItems.filter(hire => {
          const taskList = hire.onboarding_info?.onboarding_task_list || [];
          const emailTask = taskList.find(t => t.task_name === 'IT 填写工作邮箱');
          // 如果没有这个任务，或者任务状态不是 completed，说明还没开通邮箱
          const hasEmail = emailTask && emailTask.task_status === 'completed';
          console.log(`Pre-hire ${hire.pre_hire_id}: emailTask=${emailTask?.task_status}, hasEmail=${hasEmail}`);
          return !hasEmail;
        })
      : enrichedItems;

    console.log(`Filtered to ${filteredItems.length} pre-hires without email`);

    return filteredItems.map(hire => {
      const person = hire.person_info || {};
      const employment = hire.employment_info || {};
      const onboarding = hire.onboarding_info || {};
      const offer = hire.offer_info || {};

      const name = person.legal_name || person.preferred_name || '';
      const phone = (person.phone_number || '').replace(/^\+86/, '');
      const locationId = employment.work_location_id;
      const departmentId = employment.department_id;
      const onboardingDate = onboarding.onboarding_date;
      const onboardingStatus = onboarding.onboarding_status;
      const workEmail = offer.work_emails?.[0]?.email || '';

      // 获取邮箱任务状态
      const taskList = onboarding.onboarding_task_list || [];
      const emailTask = taskList.find(t => t.task_name === 'IT 填写工作邮箱');
      const emailTaskStatus = emailTask?.task_status || 'unknown';

      const cityName = locationMap[locationId] || 'Unknown';

      return {
        id: hire.pre_hire_id,
        name,
        phone,
        city: cityName,
        cityId: locationId,
        departmentId,
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
}

export const feishuService = new FeishuService();
