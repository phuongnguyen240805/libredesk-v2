import { ref, onUnmounted } from 'vue'

const STOP_DELAY = 2000
const RESEND_INTERVAL = 3000
// Receiver auto-clear must be longer than RESEND_INTERVAL to avoid flicker.
export const TYPING_RECEIVE_TIMEOUT = 5000

export function useTypingIndicator (sendTypingCallback, otherAttributes = {}) {
  let typingTimer = null
  let resendTimer = null
  const isCurrentlyTyping = ref(false)

  const startTyping = () => {
    if (!isCurrentlyTyping.value) {
      isCurrentlyTyping.value = true
      sendTypingCallback?.(true, otherAttributes)

      resendTimer = setInterval(() => {
        sendTypingCallback?.(true, otherAttributes)
      }, RESEND_INTERVAL)
    }

    if (typingTimer) {
      clearTimeout(typingTimer)
    }

    typingTimer = setTimeout(() => {
      stopTyping()
    }, STOP_DELAY)
  }

  const stopTyping = () => {
    if (typingTimer) {
      clearTimeout(typingTimer)
      typingTimer = null
    }

    if (resendTimer) {
      clearInterval(resendTimer)
      resendTimer = null
    }

    if (isCurrentlyTyping.value) {
      isCurrentlyTyping.value = false
      sendTypingCallback?.(false, otherAttributes)
    }
  }

  // Clean up on unmount
  onUnmounted(() => {
    stopTyping()
  })

  return {
    startTyping,
    stopTyping,
    isCurrentlyTyping
  }
}
