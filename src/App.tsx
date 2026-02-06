import { DiffEditor } from '@monaco-editor/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { StorageData, VersionRecord, FullContentRecord, OldPatchRecord, VersionHealth } from './types'
import { applyPatches, extractPatches, checkVersionsHealth } from './patchUtils'

// ============ 格式检测与迁移 ============

// 检测 v2 patch-based 格式
const isV2Format = (data: unknown): data is StorageData => {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  return obj.version === 2 && 'baselines' in obj && 'versions' in obj
}

// 检测 v1 旧 patch 格式
const isOldPatchFormat = (records: unknown[]): records is OldPatchRecord[] => {
  if (records.length === 0) return false
  const first = records[0] as Record<string, unknown>
  return 'path' in first && 'value' in first && !('content' in first)
}

// 检测 v1.5 full-content 格式
const isFullContentFormat = (records: unknown[]): records is FullContentRecord[] => {
  if (records.length === 0) return false
  const first = records[0] as Record<string, unknown>
  return 'content' in first && 'file' in first && 'profile' in first
}

// 从 full-content 格式迁移到 v2
const migrateFromFullContent = (
  records: FullContentRecord[],
  diskContents: Record<string, string>
): StorageData => {
  const baselines: Record<string, string> = {}
  const versions: VersionRecord[] = []

  // 按 file 分组
  const byFile: Record<string, FullContentRecord[]> = {}
  for (const r of records) {
    if (!byFile[r.file]) byFile[r.file] = []
    byFile[r.file].push(r)
  }

  for (const [file, fileRecords] of Object.entries(byFile)) {
    // 基线 = 当前磁盘内容
    const baseline = diskContents[file] ?? fileRecords[0].content
    baselines[file] = baseline

    for (const record of fileRecords) {
      const patches = extractPatches(baseline, record.content)
      versions.push({ file, profile: record.profile, patches })
    }
  }

  return { version: 2, baselines, versions }
}

// 从 v1 旧 patch 格式迁移到 v2
const migrateFromOldPatches = async (
  oldRecords: OldPatchRecord[],
  readFile: (path: string) => Promise<string>
): Promise<StorageData> => {
  const baselines: Record<string, string> = {}
  const versions: VersionRecord[] = []

  // 按 file+profile 分组
  const groups: Record<string, OldPatchRecord[]> = {}
  const profilesByFile: Record<string, string[]> = {}
  for (const record of oldRecords) {
    const key = `${record.file}|||${record.profile}`
    if (!groups[key]) groups[key] = []
    groups[key].push(record)
    if (!profilesByFile[record.file]) profilesByFile[record.file] = []
    if (!profilesByFile[record.file].includes(record.profile)) {
      profilesByFile[record.file].push(record.profile)
    }
  }

  for (const file of Object.keys(profilesByFile)) {
    let baseContent: string
    try {
      baseContent = await readFile(file)
    } catch {
      continue
    }
    baselines[file] = baseContent

    for (const profile of profilesByFile[file]) {
      const key = `${file}|||${profile}`
      const oldPatches = groups[key]?.filter(p => p.path !== '__placeholder__') ?? []
      // 旧格式的 patches 直接转成新格式
      const patches = oldPatches.map(p => ({ path: p.path, value: p.value }))
      versions.push({ file, profile, patches })
    }
  }

  return { version: 2, baselines, versions }
}

function App() {
  // ============ 核心数据状态（v2 格式）============
  const [storageData, setStorageData] = useState<StorageData>({ version: 2, baselines: {}, versions: [] })
  const [files, setFiles] = useState<string[]>([])
  const [profiles, setProfiles] = useState<Record<string, string[]>>({})
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [activeProfile, setActiveProfile] = useState<string | null>(null)
  const [diskContentByFile, setDiskContentByFile] = useState<Record<string, string>>({})
  const [appliedProfileByFile, setAppliedProfileByFile] = useState<Record<string, string>>({})
  
  // ============ 版本健康状态 ============
  const [versionHealthMap, setVersionHealthMap] = useState<Record<string, VersionHealth>>({})
  
  // ============ 编辑器状态 ============
  const [diffEditor, setDiffEditor] = useState<any>(null)
  
  // 使用 ref 存储编辑器内容，避免每次输入触发重渲染
  const sourceContentRef = useRef<string>('')
  const rightContentRef = useRef<string>('')
  const snapshotRightContentRef = useRef<string>('')
  const snapshotSourceContentRef = useRef<string>('')
  
  // 用于触发 UI 更新的状态（仅在需要显示/隐藏按钮时更新）
  const [isDirty, setIsDirty] = useState(false)
  const [leftDirty, setLeftDirty] = useState(false)
  
  // ============ UI 状态 ============
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [showProfileModal, setShowProfileModal] = useState(false)
  const [profileInput, setProfileInput] = useState('')
  const [showProfileMenu, setShowProfileMenu] = useState<{ file: string; profile: string; x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ file: string; profile: string } | null>(null)
  const [renameInput, setRenameInput] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ file: string; profile: string } | null>(null)
  const [displayProfile, setDisplayProfile] = useState<string | null>(null)

  // ============ 辅助函数 ============
  
  // 持久化 storageData
  const persistStorage = useCallback(async (data: StorageData) => {
    if (!window.api) return
    await window.api.writeStorage(data)
  }, [])

  // 从 storageData 获取版本应用后的内容
  const getVersionContent = useCallback((file: string, profile: string, data: StorageData): string | null => {
    const baseline = data.baselines[file]
    if (!baseline) return null
    const version = data.versions.find(v => v.file === file && v.profile === profile)
    if (!version) return null
    const result = applyPatches(baseline, version.patches)
    return result.content
  }, [])

  // 从 profiles 和 versions 中提取 file/profile 结构
  const rebuildProfileMap = useCallback((versions: VersionRecord[]): Record<string, string[]> => {
    const map: Record<string, string[]> = {}
    for (const v of versions) {
      if (!map[v.file]) map[v.file] = []
      if (!map[v.file].includes(v.profile)) map[v.file].push(v.profile)
    }
    return map
  }, [])

  // ============ 更新脏状态的函数 ============
  const updateDirtyState = useCallback(() => {
    if (!activeFile || !activeProfile) {
      setIsDirty(false)
    } else {
      const currentRight = rightContentRef.current
      const snapshot = snapshotRightContentRef.current
      setIsDirty(currentRight !== snapshot)
    }
    
    if (!activeFile) {
      setLeftDirty(false)
    } else {
      const currentSource = sourceContentRef.current
      const snapshot = snapshotSourceContentRef.current
      setLeftDirty(currentSource !== snapshot)
    }
  }, [activeFile, activeProfile])

  // ============ 初始化：启动时加载数据并检测当前生效版本 ============
  useEffect(() => {
    if (!window.api) {
      setError('Electron API 未注入，请用 npm run electron:dev 启动')
      return
    }
    
    const initializeApp = async () => {
      const rawData = await window.api!.readStorage()
      
      let data: StorageData
      
      if (isV2Format(rawData)) {
        // 已经是 v2 格式
        data = rawData
      } else if (Array.isArray(rawData) && rawData.length > 0) {
        // 需要迁移
        // 先读取所有文件的磁盘内容用于迁移
        const allFiles = new Set((rawData as Array<Record<string, string>>).map(r => r.file))
        const diskMap: Record<string, string> = {}
        for (const file of allFiles) {
          try {
            diskMap[file] = await window.api!.readFile(file)
          } catch { /* skip */ }
        }
        
        if (isOldPatchFormat(rawData)) {
          console.log('检测到 v1 旧 patch 格式，正在迁移...')
          data = await migrateFromOldPatches(rawData, window.api!.readFile)
        } else if (isFullContentFormat(rawData)) {
          console.log('检测到 v1.5 full-content 格式，正在迁移...')
          data = migrateFromFullContent(rawData, diskMap)
        } else {
          // 未知格式，初始化空数据
          data = { version: 2, baselines: {}, versions: [] }
        }
        
        // 保存迁移后的数据
        await persistStorage(data)
        console.log('迁移完成')
      } else {
        // 空数据或未知
        data = { version: 2, baselines: {}, versions: [] }
      }
      
      setStorageData(data)
      
      const fileSet = Object.keys(data.baselines)
      // 也加入 versions 中有但 baselines 中没有的文件
      for (const v of data.versions) {
        if (!fileSet.includes(v.file)) fileSet.push(v.file)
      }
      setFiles(fileSet)
      
      const profileMap = rebuildProfileMap(data.versions)
      setProfiles(profileMap)
      
      // 读取所有文件并检测当前生效版本
      const appliedMap: Record<string, string> = {}
      const diskMap: Record<string, string> = {}
      
      for (const file of fileSet) {
        try {
          const diskContent = await window.api!.readFile(file)
          diskMap[file] = diskContent
          
          // 更新 baselines（以磁盘内容为准）
          data.baselines[file] = diskContent
          
          // 检测哪个版本与磁盘内容匹配
          const fileProfiles = profileMap[file] ?? []
          for (const profile of fileProfiles) {
            const versionContent = getVersionContent(file, profile, data)
            if (versionContent === diskContent) {
              appliedMap[file] = profile
              break
            }
          }
        } catch {
          // 文件读取失败，跳过
        }
      }
      
      // 检查所有版本健康状态
      const healthMap: Record<string, VersionHealth> = {}
      for (const file of fileSet) {
        const baseline = data.baselines[file]
        if (!baseline) continue
        const unhealthy = checkVersionsHealth(baseline, data.versions, file)
        for (const vh of unhealthy) {
          healthMap[`${vh.file}|||${vh.profile}`] = vh
        }
      }
      setVersionHealthMap(healthMap)
      
      setDiskContentByFile(diskMap)
      setAppliedProfileByFile(appliedMap)
    }
    
    initializeApp()
  }, [getVersionContent, persistStorage, rebuildProfileMap])

  // ============ 切换文件时加载内容 ============
  useEffect(() => {
    if (!activeFile || !window.api) return
    
    const loadFile = async () => {
      let content = diskContentByFile[activeFile]
      if (!content) {
        try {
          content = await window.api!.readFile(activeFile)
          setDiskContentByFile((prev) => ({ ...prev, [activeFile]: content }))
        } catch (err) {
          setError(String(err))
          return
        }
      }
      
      // 更新 ref
      sourceContentRef.current = content
      snapshotSourceContentRef.current = content
      
      // 如果没有选中版本，右侧也显示磁盘内容
      if (!activeProfile) {
        rightContentRef.current = content
        snapshotRightContentRef.current = content
      }
      
      // 通过 Monaco API 设置内容
      if (diffEditor) {
        const originalModel = diffEditor.getOriginalEditor().getModel()
        const modifiedModel = diffEditor.getModifiedEditor().getModel()
        if (originalModel && originalModel.getValue() !== content) {
          originalModel.setValue(content)
        }
        if (!activeProfile && modifiedModel && modifiedModel.getValue() !== content) {
          modifiedModel.setValue(content)
        }
      }
      
      updateDirtyState()
    }
    
    loadFile()
  }, [activeFile, activeProfile, diskContentByFile, diffEditor, updateDirtyState])

  // ============ 切换版本时更新右侧内容 ============
  useEffect(() => {
    if (!activeFile || !activeProfile) {
      setDisplayProfile(null)
      return
    }
    
    setDisplayProfile(activeProfile)
    
    const baseline = storageData.baselines[activeFile]
    if (!baseline) return
    
    // 从 baseline + patches 得到版本内容
    const versionContent = getVersionContent(activeFile, activeProfile, storageData) ?? baseline
    
    // 检查是否有失效的 patches
    const healthKey = `${activeFile}|||${activeProfile}`
    const health = versionHealthMap[healthKey]
    if (health && health.invalidPatches.length > 0) {
      setError(`版本 ${activeProfile} 有 ${health.invalidPatches.length} 个配置项因路径变更无法应用：${health.invalidPatches.join(', ')}`)
    } else {
      setError('')
    }
    
    // 更新 ref
    rightContentRef.current = versionContent
    snapshotRightContentRef.current = versionContent
    
    // 通过 Monaco API 设置内容
    if (diffEditor) {
      const modifiedModel = diffEditor.getModifiedEditor().getModel()
      if (modifiedModel && modifiedModel.getValue() !== versionContent) {
        modifiedModel.setValue(versionContent)
      }
    }
    
    updateDirtyState()
  }, [activeFile, activeProfile, storageData, diffEditor, getVersionContent, updateDirtyState, versionHealthMap])

  // ============ 监听编辑器内容变化 ============
  useEffect(() => {
    if (!diffEditor) return
    
    const original = diffEditor.getOriginalEditor()
    const modified = diffEditor.getModifiedEditor()
    const originalModel = original.getModel()
    const modifiedModel = modified.getModel()
    if (!originalModel || !modifiedModel) return
    
    const sub1 = originalModel.onDidChangeContent(() => {
      sourceContentRef.current = originalModel.getValue()
      // 检查脏状态
      const newLeftDirty = sourceContentRef.current !== snapshotSourceContentRef.current
      if (newLeftDirty !== leftDirty) {
        setLeftDirty(newLeftDirty)
      }
    })
    
    const sub2 = modifiedModel.onDidChangeContent(() => {
      rightContentRef.current = modifiedModel.getValue()
      // 检查脏状态
      if (activeFile && activeProfile) {
        const newIsDirty = rightContentRef.current !== snapshotRightContentRef.current
        if (newIsDirty !== isDirty) {
          setIsDirty(newIsDirty)
        }
      }
    })
    
    return () => {
      sub1.dispose()
      sub2.dispose()
    }
  }, [diffEditor, activeFile, activeProfile, isDirty, leftDirty])

  // ============ 操作函数 ============
  
  const handleAddFile = async () => {
    setError('')
    setStatus('正在选择文件…')
    if (!window.api) {
      setError('Electron API 未注入')
      return
    }
    try {
      const filePath = await window.api.openJsonFile()
      if (!filePath) {
        setStatus('已取消选择')
        return
      }
      if (!files.includes(filePath)) {
        setFiles((prev) => [...prev, filePath])
      }
      setActiveFile(filePath)
      setStatus('已加载文件')
    } catch (err) {
      setError(`选择文件失败: ${String(err)}`)
    }
  }

  const handleAddProfile = (filePath: string) => {
    setActiveFile(filePath)
    setProfileInput('')
    setShowProfileModal(true)
  }

  const confirmAddProfile = async () => {
    if (!activeFile) return
    const trimmed = profileInput.trim()
    if (!trimmed) return
    
    setProfiles((prev) => ({
      ...prev,
      [activeFile]: [...new Set([...(prev[activeFile] ?? []), trimmed])],
    }))
    setActiveProfile(trimmed)
    setShowProfileModal(false)
    
    // 新版本 patches = 空（与基线完全相同）
    const newVersion: VersionRecord = {
      file: activeFile,
      profile: trimmed,
      patches: []
    }
    const newData: StorageData = {
      ...storageData,
      // 确保 baselines 存在
      baselines: {
        ...storageData.baselines,
        [activeFile]: storageData.baselines[activeFile] ?? diskContentByFile[activeFile] ?? sourceContentRef.current
      },
      versions: [...storageData.versions, newVersion]
    }
    setStorageData(newData)
    await persistStorage(newData)
  }

  const handleSelectProfile = (file: string, name: string) => {
    setActiveFile(file)
    setActiveProfile(name)
  }

  // 保存并应用当前版本
  const handleSaveAndApplyProfile = async () => {
    setError('')
    setStatus('')
    if (!activeFile || !activeProfile) {
      setError('请选择文件与版本')
      return
    }
    
    const currentContent = rightContentRef.current
    
    // 验证 JSON 有效性
    try {
      JSON.parse(currentContent)
    } catch {
      setError('JSON 格式无效，无法保存')
      return
    }
    
    // 从当前内容与基线提取 patches
    const baseline = storageData.baselines[activeFile] ?? diskContentByFile[activeFile]
    if (!baseline) {
      setError('基线内容不存在')
      return
    }
    
    const patches = extractPatches(baseline, currentContent)
    
    // 更新版本记录
    const newVersions = storageData.versions.filter(
      v => !(v.file === activeFile && v.profile === activeProfile)
    )
    newVersions.push({ file: activeFile, profile: activeProfile, patches })
    
    const newData: StorageData = { ...storageData, versions: newVersions }
    setStorageData(newData)
    
    if (!window.api) return
    await persistStorage(newData)
    
    // 保存成功后，更新快照
    snapshotRightContentRef.current = currentContent
    setIsDirty(false)
    
    // 应用到磁盘文件
    await window.api.writeFile(activeFile, currentContent)
    setDiskContentByFile((prev) => ({ ...prev, [activeFile]: currentContent }))
    setAppliedProfileByFile((prev) => ({ ...prev, [activeFile]: activeProfile }))
    
    // 清除该版本的健康警告
    setVersionHealthMap((prev) => {
      const newMap = { ...prev }
      delete newMap[`${activeFile}|||${activeProfile}`]
      return newMap
    })
    
    // 更新左侧显示和快照
    sourceContentRef.current = currentContent
    snapshotSourceContentRef.current = currentContent
    setLeftDirty(false)
    
    if (diffEditor) {
      const originalModel = diffEditor.getOriginalEditor().getModel()
      if (originalModel && originalModel.getValue() !== currentContent) {
        originalModel.setValue(currentContent)
      }
    }
    
    setStatus('已保存并应用版本')
  }

  // 应用指定版本（不修改版本内容，只写入磁盘）
  const handleApplyProfile = async (file: string, profile: string) => {
    setError('')
    setStatus('')
    if (!window.api) return
    
    const versionContent = getVersionContent(file, profile, storageData)
    if (!versionContent) {
      setError('版本内容不存在')
      return
    }
    
    // 检查健康状态
    const healthKey = `${file}|||${profile}`
    const health = versionHealthMap[healthKey]
    if (health && health.invalidPatches.length > 0) {
      setError(`警告：版本 ${profile} 有 ${health.invalidPatches.length} 个失效配置项，应用的内容可能不完整`)
    }
    
    // 写入磁盘
    await window.api.writeFile(file, versionContent)
    
    // 更新状态
    setDiskContentByFile((prev) => ({ ...prev, [file]: versionContent }))
    setAppliedProfileByFile((prev) => ({ ...prev, [file]: profile }))
    
    // 如果是当前文件，更新显示
    if (activeFile === file) {
      sourceContentRef.current = versionContent
      snapshotSourceContentRef.current = versionContent
      setLeftDirty(false)
      
      if (diffEditor) {
        const originalModel = diffEditor.getOriginalEditor().getModel()
        if (originalModel && originalModel.getValue() !== versionContent) {
          originalModel.setValue(versionContent)
        }
      }
      
      if (activeProfile === profile) {
        rightContentRef.current = versionContent
        snapshotRightContentRef.current = versionContent
        setIsDirty(false)
        
        if (diffEditor) {
          const modifiedModel = diffEditor.getModifiedEditor().getModel()
          if (modifiedModel && modifiedModel.getValue() !== versionContent) {
            modifiedModel.setValue(versionContent)
          }
        }
      }
    }
    
    setStatus('已应用版本')
  }

  // 保存左侧编辑到磁盘（更新基线）
  const handleSaveLeftSide = async () => {
    if (!activeFile || !window.api) return
    setError('')
    setStatus('')
    
    const currentContent = sourceContentRef.current
    
    // 验证 JSON 格式
    try {
      JSON.parse(currentContent)
    } catch {
      setError('JSON 格式无效，无法保存')
      return
    }
    
    // 写入磁盘
    await window.api.writeFile(activeFile, currentContent)
    setDiskContentByFile((prev) => ({ ...prev, [activeFile]: currentContent }))
    
    // 更新基线
    const newData: StorageData = {
      ...storageData,
      baselines: { ...storageData.baselines, [activeFile]: currentContent }
    }
    setStorageData(newData)
    await persistStorage(newData)
    
    // 更新快照
    snapshotSourceContentRef.current = currentContent
    setLeftDirty(false)
    
    // 清除当前生效版本标记（因为磁盘内容已改变）
    setAppliedProfileByFile((prev) => {
      const newMap = { ...prev }
      delete newMap[activeFile]
      return newMap
    })
    
    // 检查所有版本健康状态
    const unhealthy = checkVersionsHealth(currentContent, newData.versions, activeFile)
    const newHealthMap = { ...versionHealthMap }
    // 先清除该文件的旧健康状态
    for (const key of Object.keys(newHealthMap)) {
      if (key.startsWith(`${activeFile}|||`)) {
        delete newHealthMap[key]
      }
    }
    // 添加新的不健康状态
    for (const vh of unhealthy) {
      newHealthMap[`${vh.file}|||${vh.profile}`] = vh
    }
    setVersionHealthMap(newHealthMap)
    
    if (unhealthy.length > 0) {
      const warnings = unhealthy.map(vh => `${vh.profile}(${vh.invalidPatches.length}个失效)`).join(', ')
      setStatus(`已保存到磁盘。注意：以下版本受影响：${warnings}`)
    } else {
      setStatus('已保存到磁盘')
    }
    
    // 如果没有选中版本，右侧也同步
    if (!activeProfile) {
      rightContentRef.current = currentContent
      snapshotRightContentRef.current = currentContent
      
      if (diffEditor) {
        const modifiedModel = diffEditor.getModifiedEditor().getModel()
        if (modifiedModel && modifiedModel.getValue() !== currentContent) {
          modifiedModel.setValue(currentContent)
        }
      }
    }
  }

  const handleRenameProfile = (file: string, profile: string) => {
    setRenameTarget({ file, profile })
    setRenameInput(profile)
  }

  const handleDeleteProfile = (file: string, profile: string) => {
    setDeleteTarget({ file, profile })
  }

  const confirmRenameProfile = async () => {
    if (!renameTarget) return
    const trimmed = renameInput.trim()
    if (!trimmed) return
    
    setProfiles((prev) => ({
      ...prev,
      [renameTarget.file]: (prev[renameTarget.file] ?? []).map((p) => 
        p === renameTarget.profile ? trimmed : p
      ),
    }))
    
    const newVersions = storageData.versions.map((v) =>
      v.file === renameTarget.file && v.profile === renameTarget.profile
        ? { ...v, profile: trimmed }
        : v
    )
    const newData: StorageData = { ...storageData, versions: newVersions }
    setStorageData(newData)
    await persistStorage(newData)
    
    if (activeProfile === renameTarget.profile) {
      setActiveProfile(trimmed)
    }
    
    // 更新 appliedProfileByFile
    if (appliedProfileByFile[renameTarget.file] === renameTarget.profile) {
      setAppliedProfileByFile((prev) => ({ ...prev, [renameTarget.file]: trimmed }))
    }
    
    // 更新健康状态 key
    const oldKey = `${renameTarget.file}|||${renameTarget.profile}`
    const newKey = `${renameTarget.file}|||${trimmed}`
    if (versionHealthMap[oldKey]) {
      setVersionHealthMap((prev) => {
        const newMap = { ...prev }
        newMap[newKey] = { ...newMap[oldKey], profile: trimmed }
        delete newMap[oldKey]
        return newMap
      })
    }
    
    setRenameTarget(null)
  }

  const confirmDeleteProfile = async () => {
    if (!deleteTarget) return
    
    setProfiles((prev) => ({
      ...prev,
      [deleteTarget.file]: (prev[deleteTarget.file] ?? []).filter((p) => p !== deleteTarget.profile),
    }))
    
    const newVersions = storageData.versions.filter(
      (v) => !(v.file === deleteTarget.file && v.profile === deleteTarget.profile)
    )
    const newData: StorageData = { ...storageData, versions: newVersions }
    setStorageData(newData)
    await persistStorage(newData)
    
    if (activeProfile === deleteTarget.profile) {
      setActiveProfile(null)
    }
    
    // 清除 appliedProfileByFile
    if (appliedProfileByFile[deleteTarget.file] === deleteTarget.profile) {
      setAppliedProfileByFile((prev) => {
        const newMap = { ...prev }
        delete newMap[deleteTarget.file]
        return newMap
      })
    }
    
    // 清除健康状态
    const healthKey = `${deleteTarget.file}|||${deleteTarget.profile}`
    if (versionHealthMap[healthKey]) {
      setVersionHealthMap((prev) => {
        const newMap = { ...prev }
        delete newMap[healthKey]
        return newMap
      })
    }
    
    setDeleteTarget(null)
  }

  const handleExport = async () => {
    if (!window.api) return
    await window.api.exportStorage(storageData)
    setStatus('已导出配置')
  }

  const handleImport = async () => {
    if (!window.api) return
    const imported = await window.api.importStorage()
    if (!imported) return
    
    let data: StorageData
    if (isV2Format(imported)) {
      data = imported
    } else {
      // 导入的是旧格式，当作 full-content 处理
      const incoming = imported as unknown as FullContentRecord[]
      data = migrateFromFullContent(incoming, diskContentByFile)
    }
    
    setStorageData(data)
    const fileSet = Object.keys(data.baselines)
    for (const v of data.versions) {
      if (!fileSet.includes(v.file)) fileSet.push(v.file)
    }
    setFiles(fileSet)
    setProfiles(rebuildProfileMap(data.versions))
    await persistStorage(data)
    setStatus('已导入配置')
  }

  const editorOptions = useMemo(
    () => ({
      fontSize: 12,
      minimap: { enabled: false },
      wordWrap: 'on' as const,
      renderSideBySide: true,
      formatOnType: false,
      formatOnPaste: false,
      autoClosingBrackets: 'never' as const,
      autoClosingQuotes: 'never' as const,
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
      },
      overviewRulerBorder: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      lineNumbersMinChars: 3,
      folding: false,
      glyphMargin: false,
      padding: { top: 8, bottom: 8 },
    }),
    []
  )

  // ============ 渲染 ============
  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">OpenCode 配置切换器</div>
      </header>

      <div className="app-body">
        <section className="panel">
          <div className="panel-header">文件与版本</div>
          <div className="panel-body">
            <div className="file-actions">
              <button onClick={handleAddFile}>添加配置文件</button>
              <button onClick={handleExport}>导出</button>
              <button onClick={handleImport}>导入</button>
            </div>
            {files.map((file) => (
              <div key={file} className="file-item">
                <strong onClick={() => setActiveFile(file)}>{file}</strong>
                <div>
                  {(profiles[file] ?? []).map((profile) => (
                    <div
                      key={profile}
                      className={`profile-item ${activeFile === file && activeProfile === profile ? 'active' : ''} ${versionHealthMap[`${file}|||${profile}`] ? 'warning' : ''}`}
                      onClick={() => handleSelectProfile(file, profile)}
                    >
                      <span>
                        {versionHealthMap[`${file}|||${profile}`] && <span className="profile-warning" title={`${versionHealthMap[`${file}|||${profile}`].invalidPatches.length} 个配置项失效`}>⚠ </span>}
                        {profile}
                      </span>
                      <div className="profile-inline">
                        {appliedProfileByFile[file] === profile && (
                          <span className="profile-label">当前生效</span>
                        )}
                        {appliedProfileByFile[file] !== profile && (
                          <button onClick={(e) => { e.stopPropagation(); handleApplyProfile(file, profile) }}>应用</button>
                        )}
                        <button
                          className="profile-menu"
                          onClick={(event) => {
                            event.stopPropagation()
                            setShowProfileMenu({ file, profile, x: event.clientX, y: event.clientY })
                          }}
                        >
                          ⋯
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <button className="profile-add" onClick={() => handleAddProfile(file)}>+ 新建版本</button>
              </div>
            ))}
          </div>
        </section>

        <section className="panel diff-panel">
          <div className="panel-header">Diff</div>
          <div className="panel-body diff-body">
            <div className="diff-labels">
              <div className="diff-label-left">
                <span className="diff-label-text">磁盘文件内容</span>
                {leftDirty && (
                  <button className="diff-label-btn" onClick={handleSaveLeftSide}>保存到磁盘</button>
                )}
              </div>
              <div className="diff-label-right">
                <span className="diff-label-text">版本：{displayProfile ?? '未选择'}</span>
                {isDirty && (
                  <button className="diff-label-btn primary" onClick={handleSaveAndApplyProfile}>保存并应用</button>
                )}
              </div>
            </div>
            <div className="diff-editor-wrapper">
              <DiffEditor
                height="100%"
                language="json"
                onMount={(instance) => setDiffEditor(instance)}
                options={{ 
                  ...editorOptions, 
                  originalEditable: true,
                  renderOverviewRuler: false,
                }}
              />
            </div>
          </div>
        </section>
      </div>

      <div className="status-bar">
        <div>{error ? <span className="status-error">{error}</span> : status}</div>
      </div>

      {showProfileModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">新建版本</div>
            <input
              className="modal-input"
              placeholder="输入版本名称"
              value={profileInput}
              onChange={(event) => setProfileInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  confirmAddProfile()
                }
              }}
            />
            <div className="modal-actions">
              <button onClick={() => setShowProfileModal(false)}>取消</button>
              <button onClick={confirmAddProfile}>确定</button>
            </div>
          </div>
        </div>
      )}

      {showProfileMenu && (
        <div className="menu-backdrop" onClick={() => setShowProfileMenu(null)}>
          <div
            className="menu"
            style={{ top: showProfileMenu.y + 6, left: showProfileMenu.x - 120 }}
            onClick={(event) => event.stopPropagation()}
          >
            <button onClick={() => {
              handleRenameProfile(showProfileMenu.file, showProfileMenu.profile)
              setShowProfileMenu(null)
            }}>重命名</button>
            <button onClick={() => {
              handleDeleteProfile(showProfileMenu.file, showProfileMenu.profile)
              setShowProfileMenu(null)
            }}>删除</button>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">重命名版本</div>
            <input
              className="modal-input"
              placeholder="输入新名称"
              value={renameInput}
              onChange={(event) => setRenameInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  confirmRenameProfile()
                }
              }}
            />
            <div className="modal-actions">
              <button onClick={() => setRenameTarget(null)}>取消</button>
              <button onClick={confirmRenameProfile}>确定</button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">删除版本</div>
            <div className="modal-text">确定删除版本 {deleteTarget.profile}？</div>
            <div className="modal-actions">
              <button onClick={() => setDeleteTarget(null)}>取消</button>
              <button onClick={confirmDeleteProfile}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
