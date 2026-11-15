// Mocha reporter for CI: the normal "spec" output, plus a GitHub Actions error annotation for each failing
// test, so failures show on the run's summary page (annotations are visible without opening the job log).
//
//   npx mocha "out/test/unit/**/*.test.js" --reporter ./scripts/mocha-github-reporter.cjs

const Mocha = require("mocha");

/** Annotation text must not contain raw newlines or % (GitHub's workflow-command escaping). */
function escapeData(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(s) {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

class GitHubReporter extends Mocha.reporters.Spec {
  constructor(runner, options) {
    super(runner, options);
    runner.on("fail", (test, err) => {
      if (!process.env.GITHUB_ACTIONS) {
        return;
      }
      const title = test.fullTitle().slice(0, 200);
      const detail = String((err && (err.stack || err.message)) || err).slice(0, 4000);
      process.stdout.write(`::error title=${escapeProperty(title)}::${escapeData(`${title}\n${detail}`)}\n`);
    });
  }
}

module.exports = GitHubReporter;
