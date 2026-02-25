<script setup lang="ts">
import type { TtsModelInfo, PersonalityInfo } from '~/shared/types'

const props = defineProps<{
  models: readonly TtsModelInfo[]
  selectedModel: string
  selectedVoice: string
  personalities: PersonalityInfo[]
  selectedPersonality: string
}>()

const emit = defineEmits<{
  'update:voice': [payload: { model: string; voice: string }]
  'update:personality': [id: string]
}>()

const isOpen = ref(false)
const triggerEl = ref<HTMLButtonElement | null>(null)
const panelEl = ref<HTMLDivElement | null>(null)

// Track which model tab is active in the dropdown (defaults to the selected model)
const activeModelTab = ref(props.selectedModel)

// Sync activeModelTab when the selected model changes externally
watch(() => props.selectedModel, (val) => {
  activeModelTab.value = val
})

// Reset to selected model whenever dropdown opens
watch(isOpen, (open) => {
  if (open) {
    activeModelTab.value = props.selectedModel
  }
})

// Voices for the currently active tab
const displayedVoices = computed(() => {
  const model = props.models.find((m) => m.id === activeModelTab.value)
  return model ? model.voices : []
})

// Lookup the personality display name
const personalityName = computed(() => {
  const p = props.personalities.find((x) => x.id === props.selectedPersonality)
  return p ? p.name : props.selectedPersonality
})

// Short model name for display (last segment of model id)
const shortModel = computed(() => {
  const parts = props.selectedModel.split('/')
  return parts[parts.length - 1] ?? props.selectedModel
})

function toggle(): void {
  isOpen.value = !isOpen.value
}

function selectVoice(voice: string): void {
  emit('update:voice', { model: activeModelTab.value, voice })
}

function selectPersonality(id: string): void {
  emit('update:personality', id)
}

function selectModelTab(modelId: string): void {
  activeModelTab.value = modelId
}

// Close on Escape
function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isOpen.value) {
    e.stopPropagation()
    isOpen.value = false
    triggerEl.value?.focus()
  }
}

// Close on click outside
function handleClickOutside(e: MouseEvent): void {
  if (
    isOpen.value &&
    triggerEl.value &&
    panelEl.value &&
    !triggerEl.value.contains(e.target as Node) &&
    !panelEl.value.contains(e.target as Node)
  ) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown, true)
  document.addEventListener('mousedown', handleClickOutside, true)
  document.addEventListener('touchstart', handleClickOutside as EventListener, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown, true)
  document.removeEventListener('mousedown', handleClickOutside, true)
  document.removeEventListener('touchstart', handleClickOutside as EventListener, true)
})
</script>

<template>
  <div class="relative">
    <!-- Trigger button -->
    <button
      ref="triggerEl"
      class="voice-trigger min-h-[36px] px-3 py-1.5 flex items-center gap-2 text-[10px] font-mono tracking-wide transition-all duration-200 focus:outline-none focus:ring-1 focus:ring-white/30 active:scale-95 rounded-full border backdrop-blur-xl"
      :class="isOpen ? 'text-white bg-white/25 border-white/40' : 'text-white bg-white/10 border-white/20 hover:bg-white/20 hover:border-white/30'"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      aria-label="Select TTS voice and personality"
      @click="toggle"
    >
      <span class="flex items-center gap-1.5">
        <span class="text-white/50 uppercase tracking-widest">Personality:</span>
        <span>{{ personalityName }}</span>
      </span>
      <span class="text-white/20">|</span>
      <span class="flex items-center gap-1.5">
        <span class="text-white/50 uppercase tracking-widest">Voice:</span>
        <span class="truncate max-w-[120px]">{{ shortModel }}/{{ selectedVoice || 'none' }}</span>
      </span>
      <svg
        class="w-2.5 h-2.5 shrink-0 opacity-50 transition-transform duration-200 ml-0.5"
        :class="isOpen ? 'rotate-180' : ''"
        viewBox="0 0 10 6"
        fill="none"
      >
        <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <!-- Backdrop overlay -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isOpen"
        class="fixed inset-0 z-40 bg-black/30"
        @click="isOpen = false"
      />
    </Transition>

    <!-- Dropdown panel -->
    <Transition
      enter-active-class="transition-all duration-200 ease-out"
      leave-active-class="transition-all duration-150 ease-in"
      enter-from-class="opacity-0 scale-95 -translate-y-1"
      leave-to-class="opacity-0 scale-95 -translate-y-1"
    >
      <div
        v-if="isOpen"
        ref="panelEl"
        class="voice-panel absolute right-0 top-full mt-2 z-50 w-80 max-h-[520px] flex flex-col rounded-xl backdrop-blur-2xl bg-white/10 border border-white/20 shadow-[0_8px_32px_rgba(255,255,255,0.08)] overflow-hidden"
        role="listbox"
        :aria-label="`Settings panel`"
      >
        <!-- Personality section -->
        <div class="shrink-0 px-3 pt-3 pb-2">
          <span class="text-[10px] font-mono tracking-[0.2em] uppercase text-white/40">Personality</span>
          <div class="mt-2 space-y-1">
            <button
              v-for="p in personalities"
              :key="p.id"
              class="personality-item w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all duration-150 focus:outline-none focus:ring-1 focus:ring-white/30 text-left"
              :class="
                p.id === selectedPersonality
                  ? 'bg-white/20 border border-white/30'
                  : 'bg-white/5 border border-transparent hover:bg-white/10'
              "
              role="option"
              :aria-selected="p.id === selectedPersonality"
              @click="selectPersonality(p.id)"
            >
              <span
                class="shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors duration-150"
                :class="p.id === selectedPersonality ? 'border-white bg-white' : 'border-white/30'"
              >
                <span
                  v-if="p.id === selectedPersonality"
                  class="w-1.5 h-1.5 rounded-full bg-black"
                />
              </span>
              <div class="min-w-0">
                <div class="text-[11px] font-mono tracking-wide" :class="p.id === selectedPersonality ? 'text-white' : 'text-white/70'">{{ p.name }}</div>
                <div class="text-[10px] font-mono text-white/40 truncate">{{ p.description }}</div>
              </div>
            </button>
          </div>
        </div>

        <!-- Divider -->
        <div class="mx-3 border-t border-white/10" />

        <!-- Voice section header -->
        <div class="shrink-0 px-3 pt-2.5 pb-1">
          <span class="text-[10px] font-mono tracking-[0.2em] uppercase text-white/40">Voice</span>
        </div>

        <!-- Model tabs (only if multiple models) -->
        <div
          v-if="models.length > 1"
          class="shrink-0 flex px-3 pb-0 gap-1"
        >
          <button
            v-for="model in models"
            :key="model.id"
            class="model-tab flex-1 min-h-[32px] px-2 py-1.5 text-[10px] font-mono tracking-wider uppercase rounded-md transition-all duration-150 focus:outline-none focus:ring-1 focus:ring-white/30"
            :class="
              activeModelTab === model.id
                ? 'bg-white/15 text-white'
                : 'text-white/50 hover:text-white/70 hover:bg-white/5'
            "
            :aria-selected="activeModelTab === model.id"
            role="tab"
            @click="selectModelTab(model.id)"
          >
            {{ model.id.split('/').pop() }}
          </button>
        </div>

        <!-- Single model label (if only one) -->
        <div
          v-else-if="models.length === 1"
          class="shrink-0 px-3 pb-1"
        >
          <span class="text-[10px] font-mono tracking-wider uppercase text-white/30">
            {{ models[0]?.id ?? 'Model' }}
          </span>
        </div>

        <!-- Voice list -->
        <div class="voice-list flex-1 overflow-y-auto overscroll-contain px-3 py-2">
          <div
            v-if="displayedVoices.length === 0"
            class="flex items-center justify-center py-6"
          >
            <span class="text-[10px] font-mono tracking-wider text-white/30 uppercase">
              No voices available
            </span>
          </div>
          <div class="grid grid-cols-3 gap-1">
            <button
              v-for="voice in displayedVoices"
              :key="voice"
              class="voice-item min-h-[40px] flex items-center justify-center px-1.5 py-1.5 text-[10px] font-mono tracking-wide rounded-lg transition-all duration-150 focus:outline-none focus:ring-1 focus:ring-white/30"
              :class="
                voice === selectedVoice && activeModelTab === selectedModel
                  ? 'text-white bg-white/20 border border-white/30'
                  : 'text-white/60 bg-white/5 border border-transparent hover:text-white hover:bg-white/10 active:scale-95'
              "
              role="option"
              :aria-selected="voice === selectedVoice && activeModelTab === selectedModel"
              @click="selectVoice(voice)"
            >
              <span class="truncate">{{ voice }}</span>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.voice-list {
  mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    black 8px,
    black calc(100% - 8px),
    transparent 100%
  );
}

.voice-panel {
  box-shadow:
    0 8px 32px rgba(255, 255, 255, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}
</style>
