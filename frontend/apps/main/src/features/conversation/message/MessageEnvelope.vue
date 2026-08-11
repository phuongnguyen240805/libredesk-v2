<template>
  <div class="mb-1 text-xs space-y-1">
    <p v-if="message.meta.subject" class="text-foreground">
      {{ message.meta.subject }}
    </p>
    <div class="space-y-0.5">
      <p v-if="message.meta.from?.length">
        <span class="text-muted-foreground">From:</span> {{ message.meta.from.join(', ') }}
      </p>
      <p v-if="message.meta.to?.length">
        <span class="text-muted-foreground">To:</span> {{ message.meta.to.join(', ') }}
      </p>
      <p v-if="message.meta.cc?.length">
        <span class="text-muted-foreground">Cc:</span> {{ message.meta.cc.join(', ') }}
      </p>
      <p v-if="message.meta.bcc?.length">
        <span class="text-muted-foreground">Bcc:</span> {{ message.meta.bcc.join(', ') }}
      </p>
    </div>
  </div>
</template>

<script setup>
defineProps({
  message: {
    type: Object,
    required: true
  }
})
</script>
