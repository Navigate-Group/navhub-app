'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, Check, Loader2 } from 'lucide-react'
import { switchGroup } from '@/app/(auth)/actions'
import { getPalette } from '@/lib/themes'
import type { Group, UserGroup } from '@/lib/types'

interface GroupSwitcherModalProps {
  groups:      UserGroup[]
  activeGroup: Group
  onClose:     () => void
}

/**
 * Modal variant of the group switcher. Opened from the user dropdown menu's
 * "Switch group" item. Only rendered when the user belongs to more than one
 * group (the caller is responsible for hiding the trigger otherwise).
 */
export default function GroupSwitcherModal({ groups, activeGroup, onClose }: GroupSwitcherModalProps) {
  const router = useRouter()
  const [switching, setSwitching] = useState<string | null>(null)

  async function handleSwitch(groupId: string) {
    if (groupId === activeGroup.id || switching) { onClose(); return }
    setSwitching(groupId)

    const result = await switchGroup(groupId)

    if ('primaryColor' in result) {
      // Apply full palette immediately so CSS vars update before the refresh
      const palette = getPalette(result.palette_id)
      document.documentElement.style.setProperty('--palette-primary',   palette.primary)
      document.documentElement.style.setProperty('--palette-secondary', palette.secondary)
      document.documentElement.style.setProperty('--palette-accent',    palette.accent)
      document.documentElement.style.setProperty('--palette-surface',   palette.surface)
      document.documentElement.style.setProperty('--group-primary',     palette.primary)
    }

    onClose()
    router.push('/home')
    router.refresh()
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-md rounded-xl border bg-background shadow-xl"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b">
            <h2 className="text-base font-semibold text-foreground">Switch group</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Body */}
          <div className="p-3 max-h-[60vh] overflow-y-auto space-y-1">
            {groups.map((ug) => {
              const group = ug.group
              if (!group) return null
              const isActive = group.id === activeGroup.id
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => void handleSwitch(group.id)}
                  disabled={!!switching}
                  className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60"
                >
                  <span
                    className="h-3.5 w-3.5 rounded-full ring-1 ring-border shrink-0"
                    style={{ backgroundColor: group.primary_color }}
                  />
                  <span className="truncate flex-1 font-medium text-foreground">{group.name}</span>
                  {switching === group.id ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                  ) : isActive ? (
                    <Check className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}
