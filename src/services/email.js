import { pinyin } from 'pinyin-pro';
import { feishuService } from './feishu.js';
import { logger } from './logger.js';

const EMAIL_DOMAIN = '@guanghe.tv';

// 有效的后缀数字序列：避开 2 和 4
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
  if (currentSuffix === null || currentSuffix === undefined) {
    return VALID_SUFFIXES[0]; // 第一个后缀是 1
  }
  const currentIndex = VALID_SUFFIXES.indexOf(currentSuffix);
  if (currentIndex === -1 || currentIndex >= VALID_SUFFIXES.length - 1) {
    return null; // 没有更多后缀了
  }
  return VALID_SUFFIXES[currentIndex + 1];
}

class EmailService {
  /**
   * 将中文名转为拼音（纯本地计算，无 API 调用）
   */
  generatePinyin(chineseName) {
    if (!chineseName) return '';

    // Convert Chinese name to pinyin without tones, lowercase
    const pinyinResult = pinyin(chineseName, {
      toneType: 'none',
      type: 'array'
    });

    return pinyinResult.join('').toLowerCase();
  }

  /**
   * 纯本地生成建议邮箱（不调 API，仅拼音转换 + 同批去重）
   * 用于列表展示阶段，速度极快
   */
  batchGenerateEmailsLocal(users) {
    // 用于同批次去重：记录已分配的邮箱
    const usedEmails = new Set();

    return users.map(user => {
      const basePinyin = this.generatePinyin(user.name);
      if (!basePinyin) {
        return {
          ...user,
          suggested_email: null,
          email_note: '无法生成拼音'
        };
      }

      // 先尝试不带后缀
      let email = `${basePinyin}${EMAIL_DOMAIN}`;
      let suffix = null;

      // 同批去重：如果已经分配给了前面的人，递增后缀
      if (usedEmails.has(email)) {
        for (const s of VALID_SUFFIXES) {
          const candidate = `${basePinyin}${s}${EMAIL_DOMAIN}`;
          if (!usedEmails.has(candidate)) {
            email = candidate;
            suffix = s;
            break;
          }
        }
      }

      usedEmails.add(email);

      return {
        ...user,
        suggested_email: email,
        email_suffix: suffix,
        email_base_pinyin: basePinyin
      };
    });
  }

  /**
   * 为用户开通邮箱，带完整的去重+自动重试逻辑
   * 
   * 流程：
   * 1. 如果前端传了指定邮箱，先尝试用指定的
   * 2. 通过飞书通讯录 API 检查在职员工占用
   * 3. 尝试写入飞书，如果遇到离职员工占用（回收站），自动重试下一个后缀
   * 
   * @param {string} preHireId - 待入职人员 ID
   * @param {string} chineseName - 中文姓名
   * @param {string} [preferredEmail] - 前端指定的邮箱（可选）
   */
  async provisionEmailWithRetry(preHireId, chineseName, preferredEmail = null) {
    const basePinyin = this.generatePinyin(chineseName);
    if (!basePinyin) {
      throw new Error(`无法生成拼音: ${chineseName}`);
    }

    // 构建候选邮箱列表
    const candidates = this._buildCandidateList(basePinyin, preferredEmail);

    // 第一阶段：通过通讯录 API 快速跳过在职员工已占用的邮箱
    let startIndex = 0;
    for (let i = 0; i < candidates.length; i++) {
      const exists = await feishuService.checkEmailExists(candidates[i]);
      if (!exists) {
        startIndex = i;
        break;
      }
      if (i === candidates.length - 1) {
        throw new Error(`所有后缀都已被在职员工占用: ${chineseName}`);
      }
    }

    // 第二阶段：尝试写入飞书，处理离职员工回收站占用
    for (let i = startIndex; i < candidates.length; i++) {
      const email = candidates[i];
      const attempt = i - startIndex + 1;
      logger.info(`尝试开通邮箱 (第${attempt}次): ${email}`);

      const result = await feishuService.updateWorkEmail(preHireId, email);

      if (result.success) {
        return {
          success: true,
          email,
          attempts: attempt
        };
      }

      if (result.isDuplicate) {
        logger.warn(`邮箱 ${email} 被占用（可能是离职员工），尝试下一个...`);
        continue;
      }

      // 其他错误直接抛出
      throw new Error(`开通邮箱失败: ${result.msg || '未知错误'}`);
    }

    throw new Error(`所有候选邮箱都已用尽: ${chineseName}`);
  }

  /**
   * 构建候选邮箱列表
   * 如果有 preferredEmail，把它放在最前面
   */
  _buildCandidateList(basePinyin, preferredEmail) {
    const candidates = [];

    // 基础邮箱（不带后缀）
    const baseEmail = `${basePinyin}${EMAIL_DOMAIN}`;

    // 如果有指定邮箱且不同于基础邮箱，优先尝试
    if (preferredEmail && preferredEmail !== baseEmail) {
      candidates.push(preferredEmail);
    }

    // 基础邮箱
    candidates.push(baseEmail);

    // 所有后缀邮箱
    for (const suffix of VALID_SUFFIXES) {
      const email = `${basePinyin}${suffix}${EMAIL_DOMAIN}`;
      if (!candidates.includes(email)) {
        candidates.push(email);
      }
    }

    return candidates;
  }
}

export const emailService = new EmailService();
