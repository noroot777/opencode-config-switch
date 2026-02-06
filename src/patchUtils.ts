import { parseTree, findNodeAtLocation } from 'jsonc-parser'
import type { Node as JsonNode } from 'jsonc-parser'
import type { PatchRecord, VersionHealth } from './types'

// ============ JSON Pointer 工具函数 ============

/**
 * 获取 JSON 指针对应的范围
 */
export const getRangeForPointer = (
  root: JsonNode | undefined,
  pointer: string
): { start: number; end: number } | null => {
  if (!root) return null
  if (!pointer || pointer === '/') {
    return { start: root.offset, end: root.offset + root.length }
  }
  
  const segments = pointer.split('/').filter(Boolean)
  const node = findNodeAtLocation(root, segments.map(s => {
    const num = Number(s)
    return Number.isNaN(num) ? s : num
  }))
  
  if (!node) return null
  return { start: node.offset, end: node.offset + node.length }
}

/**
 * 递归收集所有叶子节点的 JSON 指针路径
 */
const collectLeafPaths = (
  node: JsonNode,
  currentPath: string,
  result: { path: string; node: JsonNode }[]
): void => {
  if (node.type === 'object' && node.children) {
    for (const property of node.children) {
      if (property.type === 'property' && property.children?.length === 2) {
        const keyNode = property.children[0]
        const valueNode = property.children[1]
        const key = keyNode.value as string
        const newPath = `${currentPath}/${key}`
        
        if (valueNode.type === 'object' || valueNode.type === 'array') {
          // 递归进入
          collectLeafPaths(valueNode, newPath, result)
        } else {
          // 叶子节点
          result.push({ path: newPath, node: valueNode })
        }
      }
    }
  } else if (node.type === 'array' && node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      const newPath = `${currentPath}/${i}`
      
      if (child.type === 'object' || child.type === 'array') {
        collectLeafPaths(child, newPath, result)
      } else {
        result.push({ path: newPath, node: child })
      }
    }
  }
}

/**
 * 获取节点在原始内容中的文本值
 */
const getNodeText = (content: string, node: JsonNode): string => {
  return content.slice(node.offset, node.offset + node.length)
}

// ============ Patch 提取函数 ============

/**
 * 从基线和版本内容提取 patches
 * 只记录与基线不同的值
 */
export const extractPatches = (
  baselineContent: string,
  versionContent: string
): PatchRecord[] => {
  const baseRoot = parseTree(baselineContent)
  const versionRoot = parseTree(versionContent)
  
  if (!baseRoot || !versionRoot) return []
  
  const patches: PatchRecord[] = []
  
  // 收集版本的所有叶子节点
  const versionLeaves: { path: string; node: JsonNode }[] = []
  collectLeafPaths(versionRoot, '', versionLeaves)
  
  // 对比每个叶子节点
  for (const { path, node: versionNode } of versionLeaves) {
    const baseRange = getRangeForPointer(baseRoot, path)
    const versionValue = getNodeText(versionContent, versionNode)
    
    if (!baseRange) {
      // 基线中不存在这个路径 - 新增的字段
      patches.push({ path, value: versionValue })
    } else {
      // 对比值
      const baseValue = baselineContent.slice(baseRange.start, baseRange.end)
      if (baseValue !== versionValue) {
        patches.push({ path, value: versionValue })
      }
    }
  }
  
  return patches
}

// ============ Patch 应用函数 ============

export interface ApplyPatchesResult {
  content: string
  invalidPatches: string[]  // 失效的 patch 路径
}

/**
 * 将 patches 应用到基线内容
 * 返回结果内容和失效的 patch 路径列表
 */
export const applyPatches = (
  baselineContent: string,
  patches: PatchRecord[]
): ApplyPatchesResult => {
  if (patches.length === 0) {
    return { content: baselineContent, invalidPatches: [] }
  }
  
  const root = parseTree(baselineContent)
  if (!root) {
    return { 
      content: baselineContent, 
      invalidPatches: patches.map(p => p.path) 
    }
  }
  
  const invalidPatches: string[] = []
  const validPatches: { patch: PatchRecord; range: { start: number; end: number } }[] = []
  
  // 检查每个 patch 的有效性
  for (const patch of patches) {
    const range = getRangeForPointer(root, patch.path)
    if (range) {
      validPatches.push({ patch, range })
    } else {
      invalidPatches.push(patch.path)
    }
  }
  
  // 按位置从后往前排序，避免偏移问题
  validPatches.sort((a, b) => b.range.start - a.range.start)
  
  // 应用有效的 patches
  let result = baselineContent
  for (const { patch, range } of validPatches) {
    result = result.slice(0, range.start) + patch.value + result.slice(range.end)
  }
  
  return { content: result, invalidPatches }
}

// ============ 版本健康检查 ============

/**
 * 检查所有版本的健康状态
 * 返回有失效 patches 的版本列表
 */
export const checkVersionsHealth = (
  baselineContent: string,
  versions: { file: string; profile: string; patches: PatchRecord[] }[],
  targetFile: string
): VersionHealth[] => {
  const root = parseTree(baselineContent)
  if (!root) return []
  
  const unhealthyVersions: VersionHealth[] = []
  
  for (const version of versions) {
    if (version.file !== targetFile) continue
    
    const invalidPatches: string[] = []
    for (const patch of version.patches) {
      const range = getRangeForPointer(root, patch.path)
      if (!range) {
        invalidPatches.push(patch.path)
      }
    }
    
    if (invalidPatches.length > 0) {
      unhealthyVersions.push({
        file: version.file,
        profile: version.profile,
        invalidPatches
      })
    }
  }
  
  return unhealthyVersions
}
