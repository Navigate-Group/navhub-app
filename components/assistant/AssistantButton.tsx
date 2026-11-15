'use client'

import { useState, useEffect } from 'react'
import { Sparkles } from 'lucide-react'
import AssistantPanel from './AssistantPanel'

interface AssistantButtonProps {
  isAdmin?:     boolean
  groupId?:     string
  sidebarMode?: boolean
  collapsed?:   boolean
  onOpen?:      () => void
}

export default function AssistantButton({
  isAdmin = false,
  groupId,
  sidebarMode = false,
  collapsed = false,
  onOpen,
}: AssistantButtonProps) {
  const [open, setOpen]                 = useState(false)
  const [personaName, setPersonaName]   = useState('NavHub Assistant')

  // Resolve the configured persona name (platform → group override)
  useEffect(() => {
    let cancelled = false
    fetch('/api/assistant/persona')
      .then(r => r.json())
      .then((j: { persona_name?: string }) => {
        if (!cancelled && j.persona_name?.trim()) setPersonaName(j.persona_name.trim())
      })
      .catch(() => { /* keep default */ })
    return () => { cancelled = true }
  }, [groupId])

  function handleOpen() {
    setOpen(true)
    onOpen?.()
  }

  // Sidebar mode — collapsed (icon only) or expanded (icon + label)
  if (sidebarMode) {
    return (
      <>
        <button
          type="button"
          onClick={handleOpen}
          title={personaName}
          aria-label={`Open ${personaName}`}
          className={
            collapsed
              ? 'w-full flex items-center justify-center py-2 rounded-md text-white/80 hover:text-white transition-colors'
              : 'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-sm font-medium text-white/85 hover:text-white transition-colors'
          }
        >
          <Sparkles
            className="h-4 w-4 flex-shrink-0"
            style={{ color: 'var(--palette-primary)' }}
          />
          {!collapsed && (
            <span className="flex flex-col items-start leading-tight">
              <span>{personaName}</span>
              <span className="text-[10px] font-normal text-white/45">Ask for help</span>
            </span>
          )}
        </button>

        {open && (
          <AssistantPanel
            isAdmin={isAdmin}
            groupId={groupId}
            personaName={personaName}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    )
  }

  // Floating button mode (used in admin layout)
  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        title="NavHub Assistant"
        aria-label="Open NavHub Assistant"
        className="fixed bottom-6 right-6 z-40 h-12 w-12 rounded-full shadow-lg flex items-center justify-center bg-primary text-primary-foreground hover:opacity-90 active:scale-95 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Sparkles className="h-5 w-5" />
      </button>

      {open && (
        <AssistantPanel
          isAdmin={isAdmin}
          groupId={groupId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
