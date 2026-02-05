import { DiffEditor } from '@monaco-editor/react'
import { parseTree } from 'jsonc-parser'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Node as JsonNode } from 'jsonc-parser'
import './App.css'
import type { PatchRecord } from './types'

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

const extractValueText = (content: string, range: { start: number; end: number }) => {
  return content.slice(range.start, range.end)
}

const applyPatches = (content: string, patches: PatchRecord[]) => {
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

const diffValues = (base: unknown, current: unknown, pointer = ''): string[] => {
  if (base === current) return []
  const baseIsArray = Array.isArray(base)
  const currentIsArray = Array.isArray(current)
  if (baseIsArray || currentIsArray) {
    if (!baseIsArray || !currentIsArray) return [pointer]
    const max = Math.max(base.length, current.length)
    const result: string[] = []
    for (let i = 0; i < max; i += 1) {
      result.push(...diffValues(base[i], current[i], `${pointer}/${i}`))
    }
    return result
  }
  if (typeof base !== 'object' || typeof current !== 'object' || base === null || current === null) {
    return [pointer]
  }
  const baseObj = base as Record<string, unknown>
  const currentObj = current as Record<string, unknown>
  const keys = new Set([...Object.keys(baseObj), ...Object.keys(currentObj)])
  const result: string[] = []
  for (const key of keys) {
    result.push(...diffValues(baseObj[key], currentObj[key], `${pointer}/${key}`))
  }
  return result
}

function App() {
  // ============ 基础状态 ============
  const [records, setRecords] = useState<PatchRecord[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [profiles, setProfiles] = useState<Record<string, string[]>>({})
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [activeProfile, setActiveProfile] = useState<string | null>(null)
  const [baselineByFile, setBaselineByFile] = useState<Record<string, string>>({})
  const [appliedProfileByFile, setAppliedProfileByFile] = useState<Record<string, string>>({})
  
  // ============ 编辑器状态 ============
  const [sourceContent, setSourceContent] = useState<string>('')
  const [rightContent, setRightContent] = useState<string>('')
  const [diffEditor, setDiffEditor] = useState<any>(null)
  const [lastEditedSide, setLastEditedSide] = useState<'left' | 'right' | null>(null)
  
  // ============ UI 状态 ============
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [showProfileModal, setShowProfileModal] = useState(false)
  const [profileInput, setProfileInput] = useState('')
  const [showProfileMenu, setShowProfileMenu] = useState<{ file: string; profile: string; x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ file: string; profile: string } | null>(null)
  const [renameInput, setRenameInput] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ file: string; profile: string } | null>(null)
  
  // ============ 关键：用于追踪右侧内容的"快照" ============
  // 这是切换版本时右侧应该显示的内容，用于判断是否有未保存的修改
  const [snapshotRightContent, setSnapshotRightContent] = useState<string>('')
  
  // 用于防止程序设置内容时触发脏检测
  const isProgrammaticChangeRef = useRef(false)

  // ============ 计算属性 ============
  
  // 计算当前版本在 JSONL 中存储的内容
  const computeVersionContent = (file: string, profile: string, baseline: string, recordList: PatchRecord[]) => {
    const patches = recordList.filter(
      (r) => r.file === file && r.profile === profile && r.path !== '__placeholder__'
    )
    return applyPatches(baseline, patches)
  }

  // 计算 pendingPaths（用于保存时提取差异路径）
  const pendingPaths = useMemo(() => {
    try {
      const baseline = activeFile ? (baselineByFile[activeFile] ?? sourceContent) : sourceContent
      const baseObj = JSON.parse(baseline)
      const currentObj = JSON.parse(rightContent)
      const diffs = diffValues(baseObj, currentObj, '')
      return diffs.filter((path) => path !== '')
    } catch {
      return []
    }
  }, [activeFile, baselineByFile, sourceContent, rightContent])

  // ============ 保存按钮显示逻辑 ============
  // 条件：选中了版本 && 右侧内容与快照不同
  const isDirty = useMemo(() => {
    if (!activeFile || !activeProfile) return false
    if (!snapshotRightContent) return false
    return rightContent !== snapshotRightContent
  }, [activeFile, activeProfile, rightContent, snapshotRightContent])

  const leftDirty = activeFile ? baselineByFile[activeFile] && baselineByFile[activeFile] !== sourceContent : false

  // ============ 初始化：启动时加载数据并检测当前生效版本 ============
  useEffect(() => {
    if (!window.api) {
      setError('Electron API 未注入，请用 npm run electron:dev 启动')
      return
    }
    
    const initializeApp = async () => {
      const data = await window.api!.readStorage()
      const normalized = (data as PatchRecord[]) ?? []
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
      const baselineMap: Record<string, string> = {}
      
      for (const file of fileSet) {
        try {
          const diskContent = await window.api!.readFile(file)
          baselineMap[file] = diskContent
          
          const fileProfiles = profileMap[file] ?? []
          for (const profile of fileProfiles) {
            const versionContent = computeVersionContent(file, profile, diskContent, normalized)
            if (versionContent === diskContent) {
              appliedMap[file] = profile
              break
            }
          }
        } catch {
          // 文件读取失败，跳过
        }
      }
      
      setBaselineByFile(baselineMap)
      setAppliedProfileByFile(appliedMap)
    }
    
    initializeApp()
  }, [])

  // ============ 切换文件时加载内容 ============
  // 注意：只加载文件内容到左侧，不重置 activeProfile
  // activeProfile 的处理由 handleSelectProfile 和版本切换的 useEffect 负责
  useEffect(() => {
    if (!activeFile || !window.api) return
    
    const loadFile = async () => {
      let content = baselineByFile[activeFile]
      if (!content) {
        try {
          content = await window.api!.readFile(activeFile)
          setBaselineByFile((prev) => ({ ...prev, [activeFile]: content }))
        } catch (err) {
          setError(String(err))
          return
        }
      }
      
      isProgrammaticChangeRef.current = true
      setSourceContent(content)
      // 如果没有选中版本，右侧也显示原文件内容
      if (!activeProfile) {
        setRightContent(content)
        setSnapshotRightContent(content)
      }
    }
    
    loadFile()
  }, [activeFile, activeProfile, baselineByFile])

  // ============ 切换版本时更新右侧内容 ============
  useEffect(() => {
    if (!activeFile || !activeProfile) return
    
    const baseline = baselineByFile[activeFile]
    if (!baseline) return
    
    const versionContent = computeVersionContent(activeFile, activeProfile, baseline, records)
    
    isProgrammaticChangeRef.current = true
    setRightContent(versionContent)
    setSnapshotRightContent(versionContent)  // 更新快照
  }, [activeFile, activeProfile, baselineByFile, records])

  // ============ 监听编辑器内容变化 ============
  useEffect(() => {
    if (!diffEditor) return
    
    const original = diffEditor.getOriginalEditor()
    const modified = diffEditor.getModifiedEditor()
    const originalModel = original.getModel()
    const modifiedModel = modified.getModel()
    if (!originalModel || !modifiedModel) return
    
    const sub1 = originalModel.onDidChangeContent(() => {
      setLastEditedSide('left')
      setSourceContent(originalModel.getValue())
    })
    
    const sub2 = modifiedModel.onDidChangeContent(() => {
      // 如果是程序设置的内容，跳过
      if (isProgrammaticChangeRef.current) {
        isProgrammaticChangeRef.current = false
        return
      }
      setLastEditedSide('right')
      setRightContent(modifiedModel.getValue())
    })
    
    return () => {
      sub1.dispose()
      sub2.dispose()
    }
  }, [diffEditor])

  // ============ 左侧编辑时同步更新右侧 ============
  useEffect(() => {
    if (!activeFile || !activeProfile) return
    if (lastEditedSide !== 'left') return
    
    const patches = records.filter((r) => r.file === activeFile && r.profile === activeProfile)
    const updated = applyPatches(sourceContent, patches)
    
    isProgrammaticChangeRef.current = true
    setRightContent(updated)
  }, [sourceContent, activeFile, activeProfile, records, lastEditedSide])

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
    const newRecords = [...records, { file: activeFile, profile: trimmed, path: '__placeholder__', value: 'null' }]
    setRecords(newRecords)
    if (window.api) {
      window.api.writeStorage(newRecords)
    }
  }

  const handleSelectProfile = (file: string, name: string) => {
    setActiveFile(file)
    setActiveProfile(name)
  }

  const handleSaveAndApplyProfile = async () => {
    setError('')
    setStatus('')
    if (!activeFile || !activeProfile) {
      setError('请选择文件与版本')
      return
    }
    if (pendingPaths.length === 0) {
      setError('没有检测到改动')
      return
    }
    const root = parseTree(rightContent)
    if (!root) {
      setError('JSON 解析失败，无法保存')
      return
    }
    
    // 移除旧的 patches，添加新的
    const newRecords: PatchRecord[] = records.filter(
      (r) => !(r.file === activeFile && r.profile === activeProfile)
    )
    const patches: PatchRecord[] = pendingPaths
      .map((path) => {
        const range = getRangeForPointer(root, path)
        if (!range) return null
        return {
          file: activeFile,
          profile: activeProfile,
          path,
          value: extractValueText(rightContent, range),
        }
      })
      .filter(Boolean) as PatchRecord[]
    
    const merged = [...newRecords, ...patches]
    setRecords(merged)
    
    if (!window.api) return
    await window.api.writeStorage(merged)
    
    // 保存成功后，更新快照为当前内容
    setSnapshotRightContent(rightContent)
    
    // 应用到文件
    await window.api.writeFile(activeFile, rightContent)
    setBaselineByFile((prev) => ({ ...prev, [activeFile]: rightContent }))
    setAppliedProfileByFile((prev) => ({ ...prev, [activeFile]: activeProfile }))
    
    isProgrammaticChangeRef.current = true
    setSourceContent(rightContent)
    
    setStatus('已保存并应用版本')
  }

  const handleApplyProfile = async (file: string, profile: string) => {
    setError('')
    setStatus('')
    if (!window.api) return
    
    const content = await window.api.readFile(file)
    const patchList = records.filter((r) => r.file === file && r.profile === profile && r.path !== '__placeholder__')
    const updated = applyPatches(content, patchList)
    await window.api.writeFile(file, updated)
    
    // 更新状态
    setBaselineByFile((prev) => ({ ...prev, [file]: updated }))
    setAppliedProfileByFile((prev) => ({ ...prev, [file]: profile }))
    
    if (activeFile === file) {
      isProgrammaticChangeRef.current = true
      setSourceContent(updated)
      setRightContent(updated)
      setSnapshotRightContent(updated)
    }
    
    setStatus('已应用版本')
  }

  const handleSaveAllVersions = async () => {
    if (!activeFile || !window.api) return
    await window.api.writeFile(activeFile, sourceContent)
    setBaselineByFile((prev) => ({ ...prev, [activeFile]: sourceContent }))
    
    if (activeProfile) {
      const patches = records.filter((r) => r.file === activeFile && r.profile === activeProfile)
      const updated = applyPatches(sourceContent, patches)
      isProgrammaticChangeRef.current = true
      setRightContent(updated)
      setSnapshotRightContent(updated)
    } else {
      isProgrammaticChangeRef.current = true
      setRightContent(sourceContent)
      setSnapshotRightContent(sourceContent)
    }
    setStatus('已保存并应用到所有版本')
  }

  const handleRenameProfile = (file: string, profile: string) => {
    setRenameTarget({ file, profile })
    setRenameInput(profile)
  }

  const handleDeleteProfile = (file: string, profile: string) => {
    setDeleteTarget({ file, profile })
  }

  const confirmRenameProfile = () => {
    if (!renameTarget) return
    const trimmed = renameInput.trim()
    if (!trimmed) return
    setProfiles((prev) => ({
      ...prev,
      [renameTarget.file]: (prev[renameTarget.file] ?? []).map((p) => (p === renameTarget.profile ? trimmed : p)),
    }))
    setRecords((prev) =>
      prev.map((record) =>
        record.file === renameTarget.file && record.profile === renameTarget.profile
          ? { ...record, profile: trimmed }
          : record
      )
    )
    if (activeProfile === renameTarget.profile) setActiveProfile(trimmed)
    setRenameTarget(null)
  }

  const confirmDeleteProfile = () => {
    if (!deleteTarget) return
    setProfiles((prev) => ({
      ...prev,
      [deleteTarget.file]: (prev[deleteTarget.file] ?? []).filter((p) => p !== deleteTarget.profile),
    }))
    setRecords((prev) => prev.filter((record) => !(record.file === deleteTarget.file && record.profile === deleteTarget.profile)))
    if (activeProfile === deleteTarget.profile) setActiveProfile(null)
    setDeleteTarget(null)
  }

  const handleExport = async () => {
    if (!window.api) return
    await window.api.exportStorage(records)
    setStatus('已导出配置')
  }

  const handleImport = async () => {
    if (!window.api) return
    const imported = await window.api.importStorage()
    if (!imported) return
    const incoming = imported as PatchRecord[]
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
    await window.api.writeStorage(incoming)
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
                <span className="diff-label-text">源文件内容</span>
                {leftDirty && (
                  <button className="diff-label-btn" onClick={handleSaveAllVersions}>保存并应用到所有版本</button>
                )}
              </div>
              <div className="diff-label-right">
                <span className="diff-label-text">版本：{activeProfile ?? '未选择'}</span>
                {isDirty && (
                  <button className="diff-label-btn primary" onClick={handleSaveAndApplyProfile}>保存并应用</button>
                )}
              </div>
            </div>
            <div className="diff-editor-wrapper">
              <DiffEditor
                height="100%"
                original={sourceContent}
                modified={rightContent}
                onMount={(instance) => setDiffEditor(instance)}
                options={{ ...editorOptions, originalEditable: true }}
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
