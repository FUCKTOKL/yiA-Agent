/**
 * L1 用户画像（PRD F1）：身份、偏好、常驻事项、事实。
 *
 * - 存储：runtime/l1/profile.json，单 JSON 文件，人类可直接编辑
 * - 生命周期：天~周级更新；M2 由 update_profile 工具显式写入
 *   （inno-agent 的 auto-profile 自动抽取留作后续增强，不在 M2 范围）
 * - 消费：ContextPack 每轮把非空画像注入系统提示词（见 context-pack.ts）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 画像的四个固定区块 */
export const SECTIONS = ["identity", "preferences", "ongoing", "facts"] as const;
export type Section = (typeof SECTIONS)[number];

export interface Profile {
  identity: string;      // 一句话身份描述
  preferences: string[]; // 偏好（如"回复用中文"）
  ongoing: string[];     // 常驻事项/进行中的项目
  facts: string[];       // 长期事实（如"住在杭州"）
}

const EMPTY: Profile = { identity: "", preferences: [], ongoing: [], facts: [] };

export class L1Store {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(this.file), { recursive: true });
  }

  /** 读画像；文件不存在/损坏时返回空画像（数据容错，不崩） */
  read(): Profile {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      return {
        identity: typeof raw.identity === "string" ? raw.identity : "",
        preferences: toArray(raw.preferences),
        ongoing: toArray(raw.ongoing),
        facts: toArray(raw.facts),
      };
    } catch {
      return { ...EMPTY };
    }
  }

  /**
   * 更新一个区块并落盘。
   * - identity：整段替换
   * - 列表区块：append=true 追加（去重），否则整列替换
   * 返回更新后的完整画像。
   */
  update(section: Section, content: string, append: boolean): Profile {
    const p = this.read();
    const text = content.trim();
    if (section === "identity") {
      p.identity = text;
    } else {
      p[section] = append
        ? Array.from(new Set([...p[section], text]))
        : text
          ? [text]
          : [];
    }
    writeFileSync(this.file, JSON.stringify(p, null, 2) + "\n", "utf8");
    return p;
  }
}

function toArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}
