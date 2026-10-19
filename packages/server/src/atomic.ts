/**
 * 原子写文件：先落同目录 tmp 再 rename —— 半截文件不会以目标名出现在磁盘上，
 * 下一次读缓存/配置时也就不会把半截内容当合法数据读走。
 *
 * 同仓同纪：arena 的榜单缓存与 vault/config.json 共用这一份（同一种纪律，不各写各的）。
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  let fd = -1;
  try {
    fd = openSync(tmp, 'w');
    const data = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* 已关闭 */
      }
    }
    // 失败路径尽力清掉 .tmp（名字含 pid，跨进程不可回收，留着就是垃圾）
    try {
      unlinkSync(tmp);
    } catch {
      /* 没落成或已被清 */
    }
    throw err;
  }
}