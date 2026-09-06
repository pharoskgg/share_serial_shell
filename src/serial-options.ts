import { z } from 'zod';

export const serialSchema = {
  path: z.string().trim().min(1, '请选择串口或输入设备路径').max(256), baudRate: z.number().int().min(1).max(4000000).default(115200),
  dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).default(8),
  stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).default('none'), rtscts: z.boolean().default(false),
};

export function serialInput(data: string, encoding: 'utf8' | 'hex', ending: 'none' | 'cr' | 'lf' | 'crlf'): Buffer {
  let bytes: Buffer;
  if (encoding === 'hex') {
    const hex = data.replace(/\s/g, '');
    if (!/^(?:[a-fA-F0-9]{2})*$/.test(hex)) { throw new Error('HEX 格式应为完整字节，例如 01 FF 0D 0A'); }
    bytes = Buffer.from(hex, 'hex');
  } else { bytes = Buffer.from(data, 'utf8'); }
  const result = Buffer.concat([bytes, Buffer.from({ none: '', cr: '\r', lf: '\n', crlf: '\r\n' }[ending])]);
  if (result.length > 16384) { throw new Error('单次最多发送 16 KiB，请分次发送'); }
  return result;
}
