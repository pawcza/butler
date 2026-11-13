// When login is on and the session has lapsed, any API call answers 401: sign in again.
export default defineNuxtPlugin(() => {
  globalThis.$fetch = $fetch.create({
    onResponseError({ response }) {
      if (response.status === 401) window.location.assign('/auth/login')
    },
  })
})
