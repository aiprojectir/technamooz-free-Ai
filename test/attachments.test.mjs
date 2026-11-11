import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAttachments } from '../src/attachments.js';

test('accepts multiple text files and extracts their content', async () => {
  const form = new FormData();
  form.append('files', new File(['sales,amount\nA,10'], 'sales.csv', { type: 'text/csv' }));
  form.append('files', new File(['notes'], 'notes.txt', { type: 'text/plain' }));
  const result = await parseAttachments(form);
  assert.deepEqual(result.names, ['sales.csv', 'notes.txt']);
  assert.match(result.parts[0].text, /sales,amount/);
  assert.match(result.parts[1].text, /notes/);
});

test('rejects unsupported extensions and more than five files', async () => {
  const bad = new FormData();
  bad.append('files', new File(['x'], 'payload.exe'));
  await assert.rejects(() => parseAttachments(bad), /پشتیبانی نمی‌شود/);
  const many = new FormData();
  for (let i=0;i<6;i++) many.append('files', new File(['x'], `f${i}.txt`));
  await assert.rejects(() => parseAttachments(many), /حداکثر ۵ فایل/);
});
