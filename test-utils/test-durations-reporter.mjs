// Playwright reporter that prints each test's duration, slowest first. CI adds
// it to every app's own reporters through PW_TEST_REPORTER, so the e2e logs
// show which tests are worth tagging @slow.
export default class TestDurationsReporter {
  #results = [];

  printsToStdio() {
    return false;
  }

  onTestEnd(test, result) {
    this.#results.push({
      title: test.titlePath().filter(Boolean).slice(1).join(' › '),
      tags: test.tags.join(' '),
      status: result.status,
      seconds: result.duration / 1000,
    });
  }

  onEnd() {
    if (!this.#results.length) return;
    const total = this.#results.reduce((sum, { seconds }) => sum + seconds, 0);
    const lines = this.#results
      .sort((a, b) => b.seconds - a.seconds)
      .map(({ title, tags, status, seconds }) => `${seconds.toFixed(1).padStart(8)}s  ${status.padEnd(8)}  ${title}${tags ? `  ${tags}` : ''}`);
    console.log(`\nTest durations (${total.toFixed(0)} s in ${this.#results.length} tests):\n${lines.join('\n')}`);
  }
}
