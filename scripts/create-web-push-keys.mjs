import { createECDH } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    subject: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'node scripts/create-web-push-keys.mjs --output .data/web-push.env --subject mailto:operator@example.com',
  );
} else {
  if (!values.output || !values.subject)
    throw new Error('需要 --output 和 --subject；输出文件必须尚不存在。');
  const subject = new URL(values.subject);
  if (
    !['mailto:', 'https:'].includes(subject.protocol) ||
    subject.username ||
    subject.password ||
    subject.search ||
    subject.hash ||
    /[\x00-\x20\x7f$`"'\\]/u.test(values.subject) ||
    values.subject.length > 2048 ||
    (subject.protocol === 'mailto:' ? !subject.pathname.includes('@') : !subject.hostname)
  )
    throw new Error('联系地址必须为有效的 mailto: 邮箱或无查询参数的 HTTPS 地址。');
  const output = resolve(values.output);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const key = createECDH('prime256v1');
  key.generateKeys();
  // ECDH may return a shorter scalar when it starts with zero bytes. VAPID
  // requires the fixed-width 32-byte P-256 private key representation.
  const privateKey = Buffer.from(key.getPrivateKey().toString('hex').padStart(64, '0'), 'hex');
  const body = [
    'MOOR_WEB_PUSH_PUBLIC_KEY=' + key.getPublicKey().toString('base64url'),
    'MOOR_WEB_PUSH_PRIVATE_KEY=' + privateKey.toString('base64url'),
    'MOOR_WEB_PUSH_SUBJECT=' + values.subject,
    '',
  ].join('\n');
  const fd = openSync(
    output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(output);
    throw error;
  } finally {
    closeSync(fd);
  }
  console.log('Web Push 配置已写入 ' + output + '（仅当前用户可读，密钥不会输出到终端）。');
}
