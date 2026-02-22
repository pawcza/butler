<template>
  <div class="min-h-screen bg-ap-bg text-white font-mono">
    <nav class="border-b border-ap-border px-6 py-3 flex items-center gap-6">
      <span class="text-ap-orange font-bold tracking-widest text-sm uppercase">GLaDOS</span>
      <NuxtLink
        to="/"
        class="text-sm text-gray-400 hover:text-white transition-colors"
        active-class="text-white"
      >
        Voice
      </NuxtLink>
      <NuxtLink
        to="/devices"
        class="text-sm text-gray-400 hover:text-white transition-colors"
        active-class="text-white"
      >
        Devices
      </NuxtLink>
    </nav>
    <NuxtPage />
  </div>
</template>
