import { DiffEditor } from '@monaco-editor/react'
import { parseTree } from 'jsonc-parser'
import { useEffect, useMemo, useState } from 'react'
import type { Node as JsonNode } from 'jsonc-parser'
import './App.css'
import type { PatchRecord } from './types'

const getRangeForPointer = (root: JsonNode | undefined, pointer: string) => {
  if (!root) return null
  if (!pointer || pointer === '/') return { start: root.offset, end: root.offset + root.length }
  const segments = pointer.split('/').filter(Boolean)
  let current: JsonNode | undefined = root
  for (const segment of segments) {
    if (!current) return null
    if (current.type === 'object') {
      const property = current.children?.find((child) => child.children?.[0]?.value === segment)
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
  const [records, setRecords] = useState<PatchRecord[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<Record<string, string[]>>({})
  const [activeProfile, setActiveProfile] = useState<string | null>(null)
  const [sourceContent, setSourceContent] = useState<string>('')
  const [rightContent, setRightContent] = useState<string>('')
  const [baselineByFile, setBaselineByFile] = useState<Record<string, string>>({})
  const [pendingPaths, setPendingPaths] = useState<string[]>([])
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [appliedProfileByFile, setAppliedProfileByFile] = useState<Record<string, string>>({})
  const [showProfileModal, setShowProfileModal] = useState(false)
  const [profileInput, setProfileInput] = useState('')
  const [showProfileMenu, setShowProfileMenu] = useState<{ file: string; profile: string; x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ file: string; profile: string } | null>(null)
  const [renameInput, setRenameInput] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ file: string; profile: string } | null>(null)
  const [diffEditor, setDiffEditor] = useState<any>(null)
  const [lastEditedSide, setLastEditedSide] = useState<'left' | 'right' | null>(null)

  useEffect(() => {
    if (!window.api) {
      setError('Electron API 未注入，请用 npm run electron:dev 启动')
      return
    }
    window.api.readStorage().then((data) => {
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
    })
  }, [])

  useEffect(() => {
    if (!activeFile) return
    if (!window.api) return
    window.api.readFile(activeFile)
      .then((content) => {
        setSourceContent(content)
        setBaselineByFile((prev) => ({ ...prev, [activeFile]: content }))
        setRightContent(content)
      })
      .catch((err) => {
        setError(String(err))
      })
  }, [activeFile])

  useEffect(() => {
    try {
      const baseline = activeFile ? (baselineByFile[activeFile] ?? sourceContent) : sourceContent
      const baseObj = JSON.parse(baseline)
      const currentObj = JSON.parse(rightContent)
      const diffs = diffValues(baseObj, currentObj, '')
      const normalized = diffs.filter((path) => path !== '')
      setPendingPaths(normalized)
    } catch {
      setPendingPaths([])
    }
  }, [activeFile, baselineByFile, sourceContent, rightContent])

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
      setLastEditedSide('right')
      setRightContent(modifiedModel.getValue())
    })
    return () => {
      sub1.dispose()
      sub2.dispose()
    }
  }, [diffEditor])

  useEffect(() => {
    if (!activeFile || !activeProfile) return
    if (lastEditedSide !== 'left') return
    const patches = records.filter((r) => r.file === activeFile && r.profile === activeProfile)
    const updated = applyPatches(sourceContent, patches)
    setRightContent(updated)
  }, [sourceContent, activeFile, activeProfile, records, lastEditedSide])

  useEffect(() => {
    if (!diffEditor) return
    const original = diffEditor.getOriginalEditor()
    const modified = diffEditor.getModifiedEditor()
    const originalModel = original.getModel()
    const modifiedModel = modified.getModel()
    if (!originalModel || !modifiedModel) return
    const sub1 = originalModel.onDidChangeContent(() => {
      setSourceContent(originalModel.getValue())
    })
    const sub2 = modifiedModel.onDidChangeContent(() => {
      setRightContent(modifiedModel.getValue())
    })
    return () => {
      sub1.dispose()
      sub2.dispose()
    }
  }, [diffEditor])


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

  const handleSelectProfile = (name: string) => {
    setActiveProfile(name)
  }

  const handleSaveProfile = () => {
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
    window.api.writeStorage(merged)
    setRightContent(rightContent)
    setStatus('已保存版本')
  }

  const handleApplyProfile = async () => {
    setError('')
    setStatus('')
    if (!activeFile || !activeProfile) {
      setError('请选择文件与版本')
      return
    }
    if (!window.api) return
    const content = await window.api.readFile(activeFile)
    const patchList = records.filter((r) => r.file === activeFile && r.profile === activeProfile && r.path !== '__placeholder__')
    const updated = applyPatches(content, patchList)
    await window.api.writeFile(activeFile, updated)
    setSourceContent(updated)
    setBaselineByFile((prev) => ({ ...prev, [activeFile]: updated }))
    setAppliedProfileByFile((prev) => ({ ...prev, [activeFile]: activeProfile }))
    setRightContent(updated)
    setStatus('已应用版本')
  }

  const handleSaveAllVersions = async () => {
    if (!activeFile || !window.api) return
    await window.api.writeFile(activeFile, sourceContent)
    setBaselineByFile((prev) => ({ ...prev, [activeFile]: sourceContent }))
    if (activeProfile) {
      const patches = records.filter((r) => r.file === activeFile && r.profile === activeProfile)
      setRightContent(applyPatches(sourceContent, patches))
    } else {
      setRightContent(sourceContent)
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
      wordWrap: 'on',
      renderSideBySide: true,
      formatOnType: false,
      formatOnPaste: false,
      autoClosingBrackets: 'never',
      autoClosingQuotes: 'never',
    }),
    []
  )

  const savedVersionContent = (() => {
    if (!activeFile || !activeProfile) return rightContent
    const base = baselineByFile[activeFile] ?? sourceContent
    const patches = records.filter((r) => r.file === activeFile && r.profile === activeProfile && r.path !== '__placeholder__')
    return applyPatches(base, patches)
  })()

  useEffect(() => {
    if (!activeFile || !activeProfile) return
    setRightContent(savedVersionContent)
  }, [activeFile, activeProfile, savedVersionContent])

  const isDirty = activeFile && activeProfile ? savedVersionContent !== rightContent : false
  const leftDirty = activeFile ? baselineByFile[activeFile] && baselineByFile[activeFile] !== sourceContent : false

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
                      onClick={() => {
                        setActiveFile(file)
                        handleSelectProfile(profile)
                      }}
                    >
                      <span>{profile}</span>
                      <div className="profile-inline">
                        {appliedProfileByFile[file] === profile && (
                          <span className="profile-label">当前生效</span>
                        )}
                        {appliedProfileByFile[file] !== profile && (
                          <button onClick={handleApplyProfile}>应用</button>
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

        <section className="panel">
          <div className="panel-header">源文件对比</div>
          <div className="panel-body">
            <div className="diff-header">
              <div>
                当前生效：{appliedProfileByFile[activeFile ?? ''] ?? '未应用'}
                {leftDirty && (
                  <button className="apply-all" onClick={handleSaveAllVersions}>保存并应用到所有版本</button>
                )}
              </div>
              <div className="diff-actions">
                {isDirty && (
                  <button className="save-version" onClick={handleSaveProfile}>保存</button>
                )}
                <span>版本：{activeProfile ?? '未选择'}</span>
              </div>
            </div>
            <DiffEditor
              height="100%"
              original={sourceContent}
              modified={rightContent}
              originalEditable={true}
              onMount={(instance) => setDiffEditor(instance)}
              options={editorOptions}
            />
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
