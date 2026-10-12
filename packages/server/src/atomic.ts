/**
 * 原子写文件：先落同目录 tmp 再 rename —— 半截文件不会以目标名出现在磁盘上，
 * 下一次读缓存/配置时也就不会把半截内容当合法数据读走。
 *
 * 同仓同纪：arena 的榜单缓存与 vault/config.json 共用这一份（同一种纪律，不各写各的）。
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    // 失败路径尽力清掉 .tmp（名字含 pid，跨进程不可回收，留着就是垃圾）
    try {
      unlinkSync(tmp);
    } catch {
      /* 没落成或已被清 */
    }
    throw err;
  }
}