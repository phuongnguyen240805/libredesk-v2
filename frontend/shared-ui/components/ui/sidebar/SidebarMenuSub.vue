<script setup>
import { cn } from '../../../lib/utils';

const props = defineProps({
  class: { type: null, required: false },
});
</script>

<template>
  <ul
    data-sidebar="menu-badge"
    :class="
      cn(
        'flex min-w-0 flex-col gap-1 border-l border-sidebar-border pl-3 ml-3 py-0.5',
        'group-data-[collapsible=icon]:hidden',
        props.class,
      )
    "
  >
    <slot />
  </ul>
</template>
