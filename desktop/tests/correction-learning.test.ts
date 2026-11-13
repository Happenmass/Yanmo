import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctedTerms } from '../correction-learning';

const cases: [string, string, string[]][] = [
  ['打开言默。', '打开言墨。', ['言墨']],
  ['明天联系沈言确认方案。', '明天联系沈砚确认方案。', ['沈砚']],
  ['明天联系张伟确认方案。', '明天联系张玮确认方案。', ['张玮']],
  ['Please contact Jon tomorrow.', 'Please contact John tomorrow.', ['John']],
  ['使用Typeles。', '使用Typeless。', ['Typeless']],
  ['Please contact Jhon.', 'Please contact John.', ['John']],
  ['联系沈言，使用Typeles。', '联系沈砚，使用Typeless。', ['沈砚', 'Typeless']],
  ['联系沈言。', '联系沈言。继续输入新句子。', []],
  ['联系沈言。', '联系。', []],
  ['联系沈言。', '联系沈言！', []],
  ['联系沈言。', '联系 沈言。', []],
  ['联系沈言。', '联系sheny。', []],
  ['联系沈言。', '联系沈言。', []],
  ['这是方案。', '那是方案。', []],
  ['请周五交付当前版本。', '下个月需要重新设计整个界面。', []],
  ['预算3500元。', '预算3600元。', []],
  ['联系沈言，抄送沈言。', '联系沈砚，抄送沈砚。', ['沈砚']],
  ['🙂联系沈言。', '🙂联系沈砚。', ['沈砚']],
];
for (const [a, b, expected] of cases) test(`纠词提取：${a} → ${b}`, () => assert.deepEqual(correctedTerms(a, b), expected));
test('超长输入跳过，避免阻塞主进程', () => assert.deepEqual(correctedTerms('甲'.repeat(3000), '乙'.repeat(3000)), []));
