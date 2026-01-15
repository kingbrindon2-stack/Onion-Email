import axios from 'axios';
import CryptoJS from 'crypto-js';
import { v4 as uuidv4 } from 'uuid';

const DIDI_BASE_URL = 'https://api.es.xiaojukeji.com';

class DidiService {
  constructor() {
    this.clientId = process.env.DIDI_CLIENT_ID;
    this.clientSecret = process.env.DIDI_CLIENT_SECRET;
    this.accessToken = process.env.DIDI_ACCESS_TOKEN;
  }

  /**
   * Generate signature for Didi API requests
   * Implements Parameter Signature (MD5/SHA1)
   */
  generateSignature(params) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = uuidv4().replace(/-/g, '').substring(0, 16);

    // Build sign params
    const signParams = {
      ...params,
      client_id: this.clientId,
      access_token: this.accessToken,
      timestamp,
      nonce
    };

    // Sort params alphabetically
    const sortedKeys = Object.keys(signParams).sort();
    const signString = sortedKeys
      .map(key => `${key}=${signParams[key]}`)
      .join('&');

    // Generate MD5 signature
    const signWithSecret = `${signString}&client_secret=${this.clientSecret}`;
    const sign = CryptoJS.MD5(signWithSecret).toString().toUpperCase();

    return {
      ...signParams,
      sign
    };
  }

  async request(method, path, params = {}) {
    const signedParams = this.generateSignature(params);
    
    const config = {
      method,
      url: `${DIDI_BASE_URL}${path}`,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (method.toUpperCase() === 'GET') {
      config.params = signedParams;
    } else {
      config.data = signedParams;
    }

    const response = await axios(config);
    
    if (response.data.errno !== 0) {
      throw new Error(`Didi API error: ${response.data.errmsg || 'Unknown error'}`);
    }

    return response.data;
  }

  /**
   * Fetch all regulation rules from Didi
   * @returns {Array} List of regulation rules
   */
  async fetchRegulations() {
    const result = await this.request('GET', '/river/Auth/getRegulationList', {
      page: 1,
      page_size: 100
    });

    const regulations = result.data?.list || [];
    
    return regulations.map(reg => ({
      id: reg.regulation_id,
      name: reg.regulation_name,
      description: reg.description || '',
      cityCode: reg.city_code,
      status: reg.status
    }));
  }

  /**
   * Add a new member to Didi Enterprise
   * @param {string} name - Employee name
   * @param {string} phone - Phone number (without +86)
   * @param {Array} regulationIds - Array of regulation IDs to assign
   * @returns {Object} Result of member creation
   */
  async addMember(name, phone, regulationIds = []) {
    if (!name || !phone) {
      throw new Error('Name and phone are required');
    }

    // Clean phone number
    const cleanPhone = phone.replace(/^\+86/, '').replace(/\D/g, '');

    const result = await this.request('POST', '/river/Member/addMember', {
      name,
      phone: cleanPhone,
      regulation_ids: regulationIds.join(','),
      employee_number: '', // Optional
      department_id: '', // Optional
      cost_center: '' // Optional
    });

    return {
      success: true,
      memberId: result.data?.member_id,
      message: 'Member added successfully'
    };
  }

  /**
   * Check if member exists by phone
   * @param {string} phone - Phone number
   * @returns {boolean} Whether member exists
   */
  async memberExists(phone) {
    try {
      const cleanPhone = phone.replace(/^\+86/, '').replace(/\D/g, '');
      const result = await this.request('GET', '/river/Member/getMemberByPhone', {
        phone: cleanPhone
      });
      return !!result.data?.member_id;
    } catch {
      return false;
    }
  }
}

export const didiService = new DidiService();
