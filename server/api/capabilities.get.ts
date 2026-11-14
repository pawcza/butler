/** What the server has configured that the page has to know up front. */
export default defineEventHandler(() => ({
  /** Without speech recognition there is nothing to do with the microphone, so the page doesn't ask for it. */
  stt: Boolean(config.STT_BASE_URL),
}))
