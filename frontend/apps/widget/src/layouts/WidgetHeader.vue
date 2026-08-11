<template>
  <div class="flex items-center justify-center p-4 border-b">
    <h3 class="text-base font-semibold text-foreground">{{ title }}</h3>
  </div>
</template>
<script setup>
defineProps(['title'])
</script>
