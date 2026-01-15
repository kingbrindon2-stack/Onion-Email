import { pinyin } from 'pinyin-pro';
import { feishuService } from './feishu.js';

const EMAIL_DOMAIN = '@guanghe.tv';

// 有效的后缀数字序列：避开 2 和 4
// 一位数：1, 3, 5, 6, 7, 8, 9
// 两位数：11, 13, 15, 16, 17, 18, 19, 31, 33, 35...（十位和个位都不含 2 和 4）
const VALID_DIGITS = [1, 3, 5, 6, 7, 8, 9];

function generateValidSuffixes() {
  const suffixes = [];
  // 一位数
  suffixes.push(...VALID_DIGITS);
  // 两位数（十位和个位都不含 2 和 4）
  for (const tens of VALID_DIGITS) {
    for (const ones of VALID_DIGITS) {
      suffixes.push(tens * 10 + ones);
    }
  }
  return suffixes;
}

const VALID_SUFFIXES = generateValidSuffixes();

// 获取下一个有效后缀
function getNextSuffix(currentSuffix) {
  if (currentSuffix === null) {
    return VALID_SUFFIXES[0]; // 第一个后缀是 1
  }
  const currentIndex = VALID_SUFFIXES.indexOf(currentSuffix);
  if (currentIndex === -1 || currentIndex >= VALID_SUFFIXES.length - 1) {
    return null; // 没有更多后缀了
  }
  return VALID_SUFFIXES[currentIndex + 1];
}

class EmailService {
  generatePinyin(chineseName) {
    if (!chineseName) return '';
    
    // Convert Chinese name to pinyin without tones, lowercase
    const pinyinResult = pinyin(chineseName, {
      toneType: 'none',
      type: 'array'
    });
    
    return pinyinResult.join('').toLowerCase();
  }

  async generateUniqueEmail(chineseName) {
    const basePinyin = this.generatePinyin(chineseName);
    if (!basePinyin) return null;

    // 首先尝试不带数字的邮箱
    let email = `${basePinyin}${EMAIL_DOMAIN}`;
    const exists = await feishuService.checkEmailExists(email);
    
    if (!exists) {
      return {
        email,
        hadDuplicate: false,
        suffix: null
      };
    }

    // 有重复，按规则添加数字后缀
    for (const suffix of VALID_SUFFIXES) {
      email = `${basePinyin}${suffix}${EMAIL_DOMAIN}`;
      const suffixExists = await feishuService.checkEmailExists(email);
      
      if (!suffixExists) {
        return {
          email,
          hadDuplicate: true,
          suffix
        };
      }
    }

    throw new Error(`Could not generate unique email for ${chineseName}: all valid suffixes exhausted`);
  }

  async batchGenerateEmails(users) {
    const results = [];
    
    for (const user of users) {
      try {
        const emailResult = await this.generateUniqueEmail(user.name);
        results.push({
          ...user,
          suggested_email: emailResult?.email || null,
          email_had_duplicate: emailResult?.hadDuplicate || false
        });
      } catch (error) {
        results.push({
          ...user,
          suggested_email: null,
          email_error: error.message
        });
      }
    }

    return results;
  }

  /**
   * 为用户开通邮箱，带自动重试逻辑
   * 如果遇到邮箱重复（包括离职员工回收站中的），自动尝试下一个后缀
   */
  async provisionEmailWithRetry(preHireId, chineseName) {
    const basePinyin = this.generatePinyin(chineseName);
    if (!basePinyin) {
      throw new Error(`无法生成拼音: ${chineseName}`);
    }

    // 先检查在职员工邮箱，确定起始后缀
    let currentSuffix = null;
    let email = `${basePinyin}${EMAIL_DOMAIN}`;
    
    // 先用 API 检查在职员工
    const baseExists = await feishuService.checkEmailExists(email);
    if (baseExists) {
      currentSuffix = VALID_SUFFIXES[0];
      email = `${basePinyin}${currentSuffix}${EMAIL_DOMAIN}`;
      
      // 继续检查带后缀的邮箱
      while (await feishuService.checkEmailExists(email)) {
        currentSuffix = getNextSuffix(currentSuffix);
        if (currentSuffix === null) {
          throw new Error(`所有后缀都已用尽: ${chineseName}`);
        }
        email = `${basePinyin}${currentSuffix}${EMAIL_DOMAIN}`;
      }
    }

    // 尝试更新邮箱，如果遇到离职员工重复，自动重试下一个后缀
    const maxRetries = VALID_SUFFIXES.length + 1;
    let attempts = 0;

    while (attempts < maxRetries) {
      attempts++;
      console.log(`尝试开通邮箱 (第${attempts}次): ${email}`);
      
      const result = await feishuService.updateWorkEmail(preHireId, email);
      
      if (result.success) {
        return {
          success: true,
          email,
          suffix: currentSuffix,
          attempts
        };
      }

      if (result.isDuplicate) {
        console.log(`邮箱 ${email} 与离职员工重复，尝试下一个后缀...`);
        currentSuffix = currentSuffix === null ? VALID_SUFFIXES[0] : getNextSuffix(currentSuffix);
        
        if (currentSuffix === null) {
          throw new Error(`所有后缀都已用尽（离职员工占用）: ${chineseName}`);
        }
        
        email = `${basePinyin}${currentSuffix}${EMAIL_DOMAIN}`;
        continue;
      }

      // 其他错误直接抛出
      throw new Error(`开通邮箱失败: ${result.msg || '未知错误'}`);
    }

    throw new Error(`超过最大重试次数: ${chineseName}`);
  }
}

export const emailService = new EmailService();
