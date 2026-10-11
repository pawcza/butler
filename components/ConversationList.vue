<script setup lang="ts">
import type { ConversationPage, ConversationSummary } from '~/shared/types'

const props = defineProps<{
  activeId: string | null
  /** Busy answering — switching threads mid-turn would split it across two. */
  disabled: boolean
}>()

const emit = defineEmits<{
  open: [id: string]
  new: []
  deleted: [id: string]
}>()

const isOpen = ref(false)
const triggerEl = ref<HTMLButtonElement | null>(null)
const panelEl = ref<HTMLDivElement | null>(null)

const items = ref<ConversationSummary[]>([])
const hasMore = ref(false)
const loading = ref(false)
const loadError = ref<string | null>(null)

async function load(more = false): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const before = more ? items.value.at(-1)?.lastMessageAt : undefined
    const page = await $fetch<ConversationPage>('/api/conversations', {
      query: before ? { before } : {},
    })
    items.value = more ? [...items.value, ...page.items] : page.items
    hasMore.value = page.hasMore
  } catch {
    loadError.value = 'Could not load conversations'
  } finally {
    loading.value = false
  }
}

watch(isOpen, (open) => {
  if (open) void load()
})

function startNew(): void {
  if (props.disabled) return
  emit('new')
  isOpen.value = false
}

function pick(id: string): void {
  if (props.disabled) return
  emit('open', id)
  isOpen.value = false
}

async function remove(conv: ConversationSummary): Promise<void> {
  if (!window.confirm(`Delete "${conv.title ?? 'Untitled'}"?`)) return
  try {
    await $fetch(`/api/conversations/${encodeURIComponent(conv.id)}`, { method: 'DELETE' })
    items.value = items.value.filter((c) => c.id !== conv.id)
    emit('deleted', conv.id)
  } catch {
    loadError.value = 'Could not delete that conversation'
  }
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
function ago(iso: string): string {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  if (minutes > -60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours > -24) return relative.format(hours, 'hour')
  return relative.format(Math.round(hours / 24), 'day')
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isOpen.value) {
    e.stopPropagation()
    isOpen.value = false
    triggerEl.value?.focus()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeyDown, true))
onUnmounted(() => document.removeEventListener('keydown', handleKeyDown, true))
</script>

<template>
  <div class="relative">
    <button
      ref="triggerEl"
      class="min-h-[36px] px-3 py-1.5 flex items-center gap-1.5 text-[10px] font-mono tracking-widest uppercase transition-all duration-200 focus:outline-none focus:ring-1 focus:ring-white/30 active:scale-95 rounded-full border backdrop-blur-xl"
      :class="isOpen ? 'text-white bg-white/25 border-white/40' : 'text-white bg-white/10 border-white/20 hover:bg-white/20 hover:border-white/30'"
      :aria-expanded="isOpen"
      aria-label="Conversations"
      @click="isOpen = !isOpen"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
      <span class="hidden sm:inline">Chats</span>
    </button>

    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="isOpen" class="fixed inset-0 z-40 bg-black/30" @click="isOpen = false" />
    </Transition>

    <Transition
      enter-active-class="transition-all duration-200 ease-out"
      leave-active-class="transition-all duration-150 ease-in"
      enter-from-class="opacity-0 scale-95 -translate-y-1"
      leave-to-class="opacity-0 scale-95 -translate-y-1"
    >
      <div
        v-if="isOpen"
        ref="panelEl"
        class="absolute right-0 top-full mt-2 z-50 w-80 max-w-[calc(100vw-2rem)] max-h-[520px] flex flex-col rounded-xl backdrop-blur-2xl bg-white/10 border border-white/20 shadow-[0_8px_32px_rgba(255,255,255,0.08)] overflow-hidden"
      >
        <div class="shrink-0 flex items-center justify-between px-3 pt-3 pb-2">
          <span class="text-[10px] font-mono tracking-[0.2em] uppercase text-white/40">Conversations</span>
          <button
            class="min-h-[32px] px-3 text-[10px] font-mono tracking-widest uppercase rounded-full border border-ap-orange/40 text-ap-orange hover:bg-ap-orange/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-ap-orange/40"
            :disabled="disabled"
            @click="startNew"
          >
            + New
          </button>
        </div>

        <div class="flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          <p v-if="loadError" class="px-2 py-3 text-[11px] font-mono text-ap-red">{{ loadError }}</p>
          <p
            v-else-if="!loading && items.length === 0"
            class="px-2 py-6 text-center text-[10px] font-mono tracking-wider uppercase text-white/30"
          >
            No conversations yet
          </p>
          <ul class="flex flex-col gap-1">
            <li v-for="conv in items" :key="conv.id" class="group flex items-stretch gap-1">
              <button
                class="flex-1 min-w-0 min-h-[44px] text-left px-3 py-2 rounded-lg transition-colors focus:outline-none focus:ring-1 focus:ring-white/30 disabled:cursor-not-allowed"
                :class="conv.id === activeId ? 'bg-white/20 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'"
                :disabled="disabled"
                @click="pick(conv.id)"
              >
                <span class="block truncate text-xs font-mono">{{ conv.title ?? 'Untitled' }}</span>
                <span class="block text-[10px] font-mono text-white/40">{{ ago(conv.lastMessageAt) }} · {{ conv.messageCount }} msg</span>
              </button>
              <button
                class="shrink-0 w-9 rounded-lg text-white/30 hover:text-ap-red hover:bg-white/10 transition-colors focus:outline-none focus:ring-1 focus:ring-white/30"
                :aria-label="`Delete ${conv.title ?? 'conversation'}`"
                @click="remove(conv)"
              >
                ×
              </button>
            </li>
          </ul>
          <button
            v-if="hasMore"
            class="w-full mt-1 min-h-[36px] text-[10px] font-mono tracking-widest uppercase text-white/50 hover:text-white rounded-lg hover:bg-white/5 transition-colors disabled:opacity-40"
            :disabled="loading"
            @click="load(true)"
          >
            {{ loading ? 'Loading…' : 'Older' }}
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
