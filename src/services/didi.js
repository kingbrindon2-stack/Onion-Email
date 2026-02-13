import axios from 'axios';
import CryptoJS from 'crypto-js';
import { logger } from './logger.js';

const DIDI_BASE_URL = 'https://api.es.xiaojukeji.com';

// 连续添加员工需间隔 150ms
const REQUEST_INTERVAL_MS = 160;

class DidiService {
  constructor() {
    // access_token 缓存（有效期 30 分钟）
    this.tokenCache = { token: null, expiresAt: 0 };
    this._lastRequestTime = 0;
  }

  // ==================== 环境变量（动态读取） ====================

  get clientId() {
    return process.env.DIDI_CLIENT_ID;
  }

  get clientSecret() {
    return process.env.DIDI_CLIENT_SECRET;
  }

  get signKey() {
    return process.env.DIDI_SIGN_KEY;
  }

  get companyId() {
    return process.env.DIDI_COMPANY_ID;
  }

  get configured() {
    return !!(this.clientId && this.clientSecret && this.signKey && this.companyId);
  }

  // ==================== 授权认证 ====================

  /**
   * 获取 access_token（自动缓存 30 分钟）
   * POST /river/Auth/authorize
   * 
   * 参考文档：https://opendocs.xiaojukeji.com/version2024/10951
   */
  async getAccessToken() {
    // 缓存有效时直接返回
    if (this.tokenCache.token && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    const timestamp = Math.floor(Date.now() / 1000);

    // 授权接口的签名：按字母序排列所有参数（不含 sign），末尾追加 sign_key
    const signParams = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
      timestamp: String(timestamp)
    };

    const sign = this._generateSign(signParams);

    const response = await axios.post(`${DIDI_BASE_URL}/river/Auth/authorize`, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
      timestamp,
      sign
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const data = response.data;

    if (!data.access_token) {
      throw new Error(`Didi auth failed: ${JSON.stringify(data)}`);
    }

    // 缓存，提前 60 秒过期以确保安全
    const expiresIn = data.expires_in || 1800;
    this.tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (expiresIn - 60) * 1000
    };

    logger.info('Didi: access_token 获取成功', { expires_in: expiresIn });
    return this.tokenCache.token;
  }

  // ==================== 签名计算 ====================

  /**
   * 生成签名
   * 
   * 规则（根据官方文档 + 返回的 params_sign_str 验证）：
   * 1. 将所有请求参数（不含 sign）和 sign_key 一起按 key 字母序排列
   * 2. 拼接为 key=value&key=value... 格式
   * 3. 对整个字符串做 MD5
   * 
   * sign_key 作为参数之一参与排序（不是追加在末尾）
   * 
   * 参考：https://opendocs.xiaojukeji.com/version2024/10947 (19999 签名错误说明)
   */
  _generateSign(params) {
    // sign_key 参与排序
    const allParams = { ...params, sign_key: this.signKey };
    const sortedKeys = Object.keys(allParams).sort();
    const signString = sortedKeys.map(key => `${key}=${allParams[key]}`).join('&');
    return CryptoJS.MD5(signString).toString();
  }

  // ==================== 请求间隔控制 ====================

  async _throttle() {
    const now = Date.now();
    const elapsed = now - this._lastRequestTime;
    if (elapsed < REQUEST_INTERVAL_MS) {
      await new Promise(resolve => setTimeout(resolve, REQUEST_INTERVAL_MS - elapsed));
    }
    this._lastRequestTime = Date.now();
  }

  // ==================== 通用请求方法 ====================

  /**
   * 发起 Didi API 请求
   * 自动注入 access_token, client_id, company_id, timestamp, sign
   */
  async request(method, path, businessParams = {}) {
    if (!this.configured) {
      throw new Error('滴滴企业版未配置，请在 .env 中填写 DIDI_CLIENT_ID、DIDI_CLIENT_SECRET、DIDI_SIGN_KEY、DIDI_COMPANY_ID');
    }

    await this._throttle();

    const accessToken = await this.getAccessToken();
    const timestamp = Math.floor(Date.now() / 1000);

    // 构建完整参数（用于签名和请求）
    const allParams = {
      client_id: this.clientId,
      access_token: accessToken,
      company_id: this.companyId,
      timestamp: String(timestamp),
      ...businessParams
    };

    // 确保所有值都是字符串（签名需要）
    const signInput = {};
    for (const [key, value] of Object.entries(allParams)) {
      if (key === 'sign') continue;
      signInput[key] = String(value);
    }

    const sign = this._generateSign(signInput);

    // 构建最终请求体（timestamp 保持数字类型）
    const requestBody = {
      ...allParams,
      timestamp,
      sign
    };

    const config = {
      method,
      url: `${DIDI_BASE_URL}${path}`,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    };

    if (method.toUpperCase() === 'GET') {
      config.params = requestBody;
    } else {
      config.data = requestBody;
    }

    const response = await axios(config);

    if (response.data.errno !== 0) {
      const err = new Error(`Didi API error [${path}]: ${response.data.errmsg || 'Unknown'} (errno: ${response.data.errno})`);
      err.errno = response.data.errno;
      err.errmsg = response.data.errmsg;
      err.didiData = response.data.data;
      err.requestId = response.data.request_id;
      throw err;
    }

    return response.data;
  }

  // ==================== 用车制度 ====================

  /**
   * 获取用车制度列表
   * GET /river/Regulation/get
   * 
   * 参考：https://opendocs.xiaojukeji.com/version2024/11313
   */
  async fetchRegulations() {
    const result = await this.request('GET', '/river/Regulation/get');

    const regulations = result.data || [];

    return regulations.map(reg => ({
      id: reg.regulation_id,
      name: reg.regulation_name,
      employeeName: reg.regulation_employee_name || '',
      employeeDescription: reg.regulation_employee_description || '',
      status: reg.regulation_status,     // "0"停用 "1"正常 "2"删除 "3"过期
      sceneType: reg.scene_type,         // 0个人 1商务 2差旅 3加班 4通勤 等
      isApprove: reg.is_approve,         // 0无需审批 1需审批
      isUseQuota: reg.is_use_quota,      // 0不用限额 1用限额
      cityType: reg.city_type,           // 0不管控 1中度 2严格 3轻度
      source: reg.source                 // 1通用规则 2行前审批 3差旅 4无需审批
    }));
  }

  // ==================== 员工管理 ====================

  /**
   * 添加员工
   * POST /river/Member/single
   * 
   * 参考：https://opendocs.xiaojukeji.com/version2024/11155
   * 
   * @param {Object} memberData - 员工信息
   * @param {string} memberData.phone - 手机号（必填）
   * @param {string} memberData.realname - 姓名（必填）
   * @param {string} [memberData.email] - 邮箱
   * @param {string} [memberData.employee_number] - 工号
   * @param {string} [memberData.regulation_id] - 制度ID（多个用_分隔）
   * @param {number} [memberData.use_company_money] - 是否企业支付（0否 1是）
   * @param {string} [memberData.residentsname] - 常驻地（如"北京"、"上海"）
   * @param {string} [memberData.budget_center_id] - 部门ID
   */
  async addMember(memberData) {
    if (!memberData.phone || !memberData.realname) {
      throw new Error('添加员工失败：phone 和 realname 是必填字段');
    }

    // 清理手机号
    const cleanPhone = memberData.phone.replace(/^\+86/, '').replace(/\D/g, '');

    // 构建 data JSON 对象
    const dataObj = {
      phone: cleanPhone,
      realname: memberData.realname,
      use_company_money: memberData.use_company_money ?? 1, // 默认企业支付
    };

    // 可选字段
    if (memberData.email) dataObj.email = memberData.email;
    if (memberData.employee_number) dataObj.employee_number = memberData.employee_number;
    if (memberData.regulation_id) dataObj.regulation_id = memberData.regulation_id;
    if (memberData.residentsname) dataObj.residentsname = memberData.residentsname;
    if (memberData.budget_center_id) dataObj.budget_center_id = memberData.budget_center_id;

    // data 必须是 JSON 字符串
    const dataStr = JSON.stringify(dataObj);

    logger.info(`Didi: 添加员工 ${memberData.realname}`, {
      phone: cleanPhone,
      regulation_id: memberData.regulation_id || '(无)'
    });

    try {
      const result = await this.request('POST', '/river/Member/single', {
        data: dataStr
      });

      logger.success(`Didi: 员工添加成功 ${memberData.realname}`, {
        member_id: result.data?.id,
        phone: result.data?.phone
      });

      return {
        success: true,
        memberId: result.data?.id,
        phone: result.data?.phone,
        message: '员工添加成功'
      };
    } catch (err) {
      // 特殊处理：员工已存在
      if (err.errno === 50202) {
        const status = err.didiData?.status;
        const statusText = { 1: '正常', 4: '离职', 6: '未绑定手机号' }[status] || '未知';
        logger.warn(`Didi: 员工已存在 ${memberData.realname}`, {
          member_id: err.didiData?.member_id || err.didiData?.id,
          phone: err.didiData?.phone,
          status: statusText
        });

        return {
          success: false,
          alreadyExists: true,
          memberId: err.didiData?.member_id || err.didiData?.id,
          phone: err.didiData?.phone,
          status,
          statusText,
          message: err.errmsg
        };
      }

      throw err;
    }
  }

  /**
   * 查询员工列表
   * GET /river/Member/get
   * 
   * 参考：https://opendocs.xiaojukeji.com/version2024/11163
   * 
   * @param {Object} [filters] - 查询条件
   * @param {string} [filters.phone] - 手机号（精确查询）
   * @param {string} [filters.realname] - 姓名（模糊查询）
   * @param {string} [filters.email] - 邮箱
   * @param {string} [filters.employee_number] - 工号（精确查询）
   * @param {string} [filters.status] - 状态（1正常,4离职,6未绑定，多个逗号分隔）
   * @param {number} [filters.offset=0] - 偏移量（必须是 length 的整数倍）
   * @param {number} [filters.length=100] - 每页数量（最大100）
   */
  async getMembers(filters = {}) {
    const params = {
      offset: String(filters.offset ?? 0),
      length: String(filters.length ?? 100)
    };

    if (filters.phone) params.phone = filters.phone.replace(/^\+86/, '').replace(/\D/g, '');
    if (filters.realname) params.realname = filters.realname;
    if (filters.email) params.email = filters.email;
    if (filters.employee_number) params.employee_number = filters.employee_number;
    if (filters.status) params.status = filters.status;

    const result = await this.request('GET', '/river/Member/get', params);

    return {
      total: result.data?.total || 0,
      records: (result.data?.records || []).map(r => ({
        id: r.id,
        phone: r.phone,
        realname: r.realname,
        email: r.email || '',
        employeeNumber: r.employee_number || '',
        residentsname: r.residentsname || '',
        useCompanyMoney: r.use_company_money,
        regulationIds: r.regulation_id || [],
        budgetCenterId: r.budget_center_id,
        status: r.dismiss_time ? 'dismissed' : 'active'
      }))
    };
  }

  /**
   * 根据手机号检查员工是否存在
   * @param {string} phone - 手机号
   * @returns {{ exists: boolean, member?: Object }}
   */
  async memberExists(phone) {
    try {
      const cleanPhone = phone.replace(/^\+86/, '').replace(/\D/g, '');
      const result = await this.getMembers({ phone: cleanPhone, status: '1,6' });
      const member = result.records.find(r => r.phone === cleanPhone);
      return {
        exists: !!member,
        member: member || null
      };
    } catch {
      return { exists: false, member: null };
    }
  }

  /**
   * 为新员工添加滴滴账号（高级封装）
   * 自动处理：已存在检测 + 制度匹配 + 企业支付
   * 
   * @param {string} name - 姓名
   * @param {string} phone - 手机号
   * @param {string} [regulationId] - 制度ID（多个用_分隔）
   * @param {Object} [options] - 额外选项
   * @param {string} [options.email] - 邮箱
   * @param {string} [options.residentsname] - 常驻地
   */
  async provisionMember(name, phone, regulationId = null, options = {}) {
    // 先检查是否已存在
    const { exists, member } = await this.memberExists(phone);
    if (exists) {
      logger.info(`Didi: ${name} 已存在，跳过添加`, { member_id: member?.id });
      return {
        success: true,
        alreadyExists: true,
        memberId: member?.id,
        message: `员工已存在 (ID: ${member?.id})`
      };
    }

    // 添加员工
    return await this.addMember({
      phone,
      realname: name,
      regulation_id: regulationId || undefined,
      use_company_money: 1,
      email: options.email || undefined,
      residentsname: options.residentsname || undefined
    });
  }
}

export const didiService = new DidiService();
