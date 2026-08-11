import { defineStore } from 'pinia'
import { ref } from 'vue'
import { setApiSessionToken } from '@widget/api/index.js'

export const useUserStore = defineStore('user', () => {
    const userSessionToken = ref("")
    const isVisitor = ref(true)
    const userID = ref(null)
    const firstName = ref('')
    const lastName = ref('')

    const setUserMeta = ({ user_id, is_visitor, first_name, last_name }) => {
        userID.value = user_id || null
        isVisitor.value = is_visitor !== undefined ? is_visitor : true
        firstName.value = first_name || ''
        lastName.value = last_name || ''
    }

    const clearSessionToken = () => {
        userSessionToken.value = ""
        setApiSessionToken('')
        isVisitor.value = true
        userID.value = null
        firstName.value = ''
        lastName.value = ''
    }

    const setSessionToken = (token) => {
        if (typeof token !== 'string') {
            throw new Error('Session token must be a string')
        }
        userSessionToken.value = token
    }

    return {
        userSessionToken,
        isVisitor,
        userID,
        firstName,
        lastName,
        setUserMeta,
        clearSessionToken,
        setSessionToken
    }
})
