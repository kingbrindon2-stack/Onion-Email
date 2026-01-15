import dotenv from 'dotenv';
dotenv.config();

import { feishuService } from './src/services/feishu.js';
import { emailService } from './src/services/email.js';

async function test() {
  console.log('Testing full flow...\n');
  
  try {
    // 1. Get enriched pre-hires
    console.log('1. Fetching enriched pre-hires...');
    const hires = await feishuService.getEnrichedPreHires();
    console.log(`   Found ${hires.length} pre-hires\n`);
    
    // 2. Generate emails for first 3
    console.log('2. Generating emails...');
    const sample = hires.slice(0, 3);
    
    for (const hire of sample) {
      const emailResult = await emailService.generateUniqueEmail(hire.name);
      console.log(`   ${hire.name} -> ${emailResult?.email || 'N/A'} ${emailResult?.hadDuplicate ? '(deduped)' : ''}`);
    }
    
    console.log('\n3. Sample data:');
    sample.forEach((h, i) => {
      console.log(`   ${i+1}. ${h.name} | ${h.phone} | ${h.city} | ${h.onboardingDate}`);
    });
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();
