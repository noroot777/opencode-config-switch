import { DiffEditor } from '@monaco-editor/react'
import { parseTree } from 'jsonc-parser'
import type { Node as JsonNode } from 'jsonc-parser'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

interface VersionRecord {
  file: string
  profile: string
  content: string  // 存储完整内容
}

// 旧格式 - 用于迁移
interface OldPatchRecord {
  file: string
  profile: string
  path: string
  value: string
}

// ============ 旧格式迁移工具函数 ============

const getRangeForPointer = (root: JsonNode | undefined, pointer: string): { start: number; end: number } | null => {
  if (!root) return null
  if (!pointer || pointer === '/') return { start: root.offset, end: root.offset + root.length }
  const segments = pointer.split('/').filter(Boolean)
  let current: JsonNode | undefined = root
  for (const segment of segments) {
    if (!current) return null
    if (current.type === 'object') {
      const property: JsonNode | undefined = current.children?.find((child) => child.children?.[0]?.value === segment)
      current = property?.children?.[1]
    } else if (current.type === 'array') {
      const index = Number(segment)
      if (Number.isNaN(index)) return null
      current = current.children?.[index]
    } else {
      return null
    }
  }
  if (!current) return null
  return { start: current.offset, end: current.offset + current.length }
}

const applyPatches = (content: string, patches: OldPatchRecord[]) => {
  const root = parseTree(content)
  if (!root) return content
  let updated = content
  const ranges = patches
    .map((patch) => ({ patch, range: getRangeForPointer(root, patch.path) }))
    .filter((item) => item.range)
    .sort((a, b) => (b.range!.start - a.range!.start))
  for (const item of ranges) {
    updated =
      updated.slice(0, item.range!.start) +
      item.patch.value +
      updated.slice(item.range!.end)
  }
  return updated
}

// 检测是否是旧格式
const isOldFormat = (records: unknown[]): records is OldPatchRecord[] => {
  if (records.length === 0) return false
  const first = records[0] as Record<string, unknown>
  return 'path' in first && 'value' in first && !('content' in first)
}

// 迁移旧格式到新格式
const migrateOldRecords = async (
  oldRecords: OldPatchRecord[],
  readFile: (path: string) => Promise<string>
): Promise<VersionRecord[]> => {
  // 按 file+profile 分组
  const groups: Record<string, OldPatchRecord[]> = {}
  const profilesByFile: Record<string, string[]> = {}
  
  oldRecords.forEach((record) => {
    const key = `${record.file}|||${record.profile}`
    if (!groups[key]) groups[key] = []
    groups[key].push(record)
    
    if (!profilesByFile[record.file]) profilesByFile[record.file] = []
    if (!profilesByFile[record.file].includes(record.profile)) {
      profilesByFile[record.file].push(record.profile)
    }
  })
  
  const newRecords: VersionRecord[] = []
  
  for (const file of Object.keys(profilesByFile)) {
    let baseContent: string
    try {
      baseContent = await readFile(file)
    } catch {
      // 文件不存在，跳过这个文件的所有版本
      continue
    }
    
    for (const profile of profilesByFile[file]) {
      const key = `${file}|||${profile}`
      const patches = groups[key]?.filter(p => p.path !== '__placeholder__') ?? []
      
      // 应用 patches 得到版本内容
      const versionContent = patches.length > 0 
        ? applyPatches(baseContent, patches)
        : baseContent
      
      newRecords.push({
        file,
        profile,
        content: versionContent
      })
    }
  }
  
  return newRecords
}

function App() {
  // ============ 基础状态 ============
  const [records, setRecords] = useState<VersionRecord[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [profiles, setProfiles] = useState<Record<string, string[]>>({})
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [activeProfile, setActiveProfile] = useState<string | null>(null)
  const [diskContentByFile, setDiskContentByFile] = useState<Record<string, string>>({})
  const [appliedProfileByFile, setAppliedProfileByFile] = useState<Record<string, string>>({})
  
  // ============ 编辑器状态 ============
  const [diffEditor, setDiffEditor] = useState<any>(null)
  
  // 使用 ref 存储编辑器内容，避免每次输入触发重渲染
  const sourceContentRef = useRef<string>('')
  const rightContentRef = useRef<string>('')
  const snapshotRightContentRef = useRef<string>('')
  const snapshotSourceContentRef = useRef<string>('')  // 用于检测左侧是否有修改
  
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
  
  // 用于显示当前版本名（避免频繁更新）
  const [displayProfile, setDisplayProfile] = useState<string | null>(null)

  // ============ 计算属性 ============
  
  // 获取版本存储的内容
  const getVersionContent = useCallback((file: string, profile: string, recordList: VersionRecord[]) => {
    const record = recordList.find(r => r.file === file && r.profile === profile)
    return record?.content ?? null
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
      const data = await window.api!.readStorage()
      const rawRecords = (data ?? []) as unknown[]
      
      // 检测并迁移旧格式
      let normalized: VersionRecord[]
      if (isOldFormat(rawRecords)) {
        console.log('检测到旧格式数据，正在迁移...')
        normalized = await migrateOldRecords(rawRecords, window.api!.readFile)
        // 保存迁移后的数据
        await window.api!.writeStorage(normalized as unknown as Array<Record<string, unknown>>)
        console.log('迁移完成，共', normalized.length, '个版本')
      } else {
        normalized = rawRecords as VersionRecord[]
      }
      
      setRecords(normalized)
      
      const fileSet = Array.from(new Set(normalized.map((r) => r.file)))
      setFiles(fileSet)
      
      const profileMap: Record<string, string[]> = {}
      normalized.forEach((record) => {
        if (!profileMap[record.file]) profileMap[record.file] = []
        if (!profileMap[record.file].includes(record.profile)) {
          profileMap[record.file].push(record.profile)
        }
      })
      setProfiles(profileMap)
      
      // 读取所有文件并检测当前生效版本
      const appliedMap: Record<string, string> = {}
      const diskMap: Record<string, string> = {}
      
      for (const file of fileSet) {
        try {
          const diskContent = await window.api!.readFile(file)
          diskMap[file] = diskContent
          
          // 检测哪个版本与磁盘内容匹配
          const fileProfiles = profileMap[file] ?? []
          for (const profile of fileProfiles) {
            const versionContent = getVersionContent(file, profile, normalized)
            if (versionContent === diskContent) {
              appliedMap[file] = profile
              break
            }
          }
        } catch {
          // 文件读取失败，跳过
        }
      }
      
      setDiskContentByFile(diskMap)
      setAppliedProfileByFile(appliedMap)
    }
    
    initializeApp()
  }, [getVersionContent])

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
    
    const diskContent = diskContentByFile[activeFile]
    if (!diskContent) return
    
    // 获取版本存储的内容，如果没有则使用磁盘内容
    const versionContent = getVersionContent(activeFile, activeProfile, records) ?? diskContent
    
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
  }, [activeFile, activeProfile, diskContentByFile, records, diffEditor, getVersionContent, updateDirtyState])

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

  const confirmAddProfile = () => {
    if (!activeFile) return
    const trimmed = profileInput.trim()
    if (!trimmed) return
    
    setProfiles((prev) => ({
      ...prev,
      [activeFile]: [...new Set([...(prev[activeFile] ?? []), trimmed])],
    }))
    setActiveProfile(trimmed)
    setShowProfileModal(false)
    
    // 新版本初始内容 = 当前磁盘内容
    const diskContent = diskContentByFile[activeFile] ?? sourceContentRef.current
    const newRecord: VersionRecord = {
      file: activeFile,
      profile: trimmed,
      content: diskContent
    }
    const newRecords = [...records, newRecord]
    setRecords(newRecords)
    
    if (window.api) {
      window.api.writeStorage(newRecords as unknown as Array<Record<string, unknown>>)
    }
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
    
    // 更新版本记录
    const existingIndex = records.findIndex(
      r => r.file === activeFile && r.profile === activeProfile
    )
    
    let newRecords: VersionRecord[]
    if (existingIndex >= 0) {
      newRecords = [...records]
      newRecords[existingIndex] = {
        file: activeFile,
        profile: activeProfile,
        content: currentContent
      }
    } else {
      newRecords = [...records, {
        file: activeFile,
        profile: activeProfile,
        content: currentContent
      }]
    }
    
    setRecords(newRecords)
    
    if (!window.api) return
    await window.api.writeStorage(newRecords as unknown as Array<Record<string, unknown>>)
    
    // 保存成功后，更新快照
    snapshotRightContentRef.current = currentContent
    setIsDirty(false)
    
    // 应用到磁盘文件
    await window.api.writeFile(activeFile, currentContent)
    setDiskContentByFile((prev) => ({ ...prev, [activeFile]: currentContent }))
    setAppliedProfileByFile((prev) => ({ ...prev, [activeFile]: activeProfile }))
    
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
    
    const versionContent = getVersionContent(file, profile, records)
    if (!versionContent) {
      setError('版本内容不存在')
      return
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

  // 保存左侧编辑到磁盘
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
    
    // 更新快照
    snapshotSourceContentRef.current = currentContent
    setLeftDirty(false)
    
    // 清除当前生效版本标记（因为磁盘内容已改变）
    setAppliedProfileByFile((prev) => {
      const newMap = { ...prev }
      delete newMap[activeFile]
      return newMap
    })
    
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
    
    setStatus('已保存到磁盘')
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
    
    const newRecords = records.map((record) =>
      record.file === renameTarget.file && record.profile === renameTarget.profile
        ? { ...record, profile: trimmed }
        : record
    )
    setRecords(newRecords)
    
    if (window.api) {
      await window.api.writeStorage(newRecords as unknown as Array<Record<string, unknown>>)
    }
    
    if (activeProfile === renameTarget.profile) {
      setActiveProfile(trimmed)
    }
    
    // 更新 appliedProfileByFile
    if (appliedProfileByFile[renameTarget.file] === renameTarget.profile) {
      setAppliedProfileByFile((prev) => ({ ...prev, [renameTarget.file]: trimmed }))
    }
    
    setRenameTarget(null)
  }

  const confirmDeleteProfile = async () => {
    if (!deleteTarget) return
    
    setProfiles((prev) => ({
      ...prev,
      [deleteTarget.file]: (prev[deleteTarget.file] ?? []).filter((p) => p !== deleteTarget.profile),
    }))
    
    const newRecords = records.filter(
      (record) => !(record.file === deleteTarget.file && record.profile === deleteTarget.profile)
    )
    setRecords(newRecords)
    
    if (window.api) {
      await window.api.writeStorage(newRecords as unknown as Array<Record<string, unknown>>)
    }
    
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
    
    setDeleteTarget(null)
  }

  const handleExport = async () => {
    if (!window.api) return
    await window.api.exportStorage(records as unknown as Array<Record<string, unknown>>)
    setStatus('已导出配置')
  }

  const handleImport = async () => {
    if (!window.api) return
    const imported = await window.api.importStorage()
    if (!imported) return
    const incoming = imported as unknown as VersionRecord[]
    setRecords(incoming)
    const fileSet = Array.from(new Set(incoming.map((r) => r.file)))
    setFiles(fileSet)
    const profileMap: Record<string, string[]> = {}
    incoming.forEach((record) => {
      if (!profileMap[record.file]) profileMap[record.file] = []
      if (!profileMap[record.file].includes(record.profile)) {
        profileMap[record.file].push(record.profile)
      }
    })
    setProfiles(profileMap)
    await window.api.writeStorage(incoming as unknown as Array<Record<string, unknown>>)
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
                      className={`profile-item ${activeFile === file && activeProfile === profile ? 'active' : ''}`}
                      onClick={() => handleSelectProfile(file, profile)}
                    >
                      <span>{profile}</span>
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
