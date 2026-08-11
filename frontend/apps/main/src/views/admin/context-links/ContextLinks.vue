<template>
  <AdminSplitLayout>
    <template #content>
      <router-view />
    </template>

    <template #help>
      <p>{{ $t('admin.contextLink.help.description') }}</p>
      <p>{{ $t('admin.contextLink.help.detail') }}</p>
      <a
        href="https://docs.libredesk.io/configuration/context-links"
        target="_blank"
        rel="noopener noreferrer"
        class="link-style"
      >
        {{ $t('globals.terms.learnMore') }}
      </a>
    </template>
  </AdminSplitLayout>
</template>

<script setup>
import AdminSplitLayout from '@/layouts/admin/AdminSplitLayout.vue'
</script>
