// ============ Patch-Based 数据模型 (v2) ============

// 单个 patch 记录
export interface PatchRecord {
  path: string   // JSON pointer, e.g., "/server/port"
  value: string  // 原始 JSON 文本片段
}

// 版本记录 - 存储与基线的差异
export interface VersionRecord {
  file: string
  profile: string
  patches: PatchRecord[]
}

// 版本健康状态
export interface VersionHealth {
  file: string
  profile: string
  invalidPatches: string[]  // 失效的 patch 路径列表
}

// 存储数据结构
export interface StorageData {
  version: 2
  baselines: Record<string, string>  // file -> 基线内容
  versions: VersionRecord[]
}

// ============ 旧格式类型（用于迁移）============

// v1 旧格式 - patch 格式
export interface OldPatchRecord {
  file: string
  profile: string
  path: string
  value: string
}

// v1.5 中间格式 - full-content 格式
export interface FullContentRecord {
  file: string
  profile: string
  content: string
}

// ============ UI 辅助类型 ============

export interface FileEntry {
  path: string
  profiles: string[]
}

export interface TreeNode {
  key: string
  path: string
  type: string
  valuePreview: string
  children?: TreeNode[]
}
