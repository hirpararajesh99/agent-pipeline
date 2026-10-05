export function noneVcs(cfg) {
  return {
    async prepare() { return { workDir: cfg.workspace }; },
    async checkIn() { return { ref: 'none' }; },
  };
}
