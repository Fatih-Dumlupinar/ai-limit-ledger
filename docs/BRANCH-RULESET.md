# Main branch ruleset checklist

Task 12 adds the workflows but intentionally does not create or change a GitHub ruleset. After
reviewing and merging the pull request, configure the repository's `main` ruleset in the GitHub
UI.

## Required status checks

Select the exact checks exposed by the workflows:

- `CI / Quality (ubuntu-latest)`
- `CI / Quality (windows-latest)`
- `CI / Package`
- `CodeQL / Analyze`
- `Secret Scan / Secret Scan`
- `Dependency Review / Dependency Review`

The names come from the workflow `name` and job `name` fields. GitHub may show a check only after
the workflow has run once; select the exact generated name, not a manually typed approximation.

## Recommended `main` settings

1. Target branch `main`.
2. Require a pull request before merging.
3. Require the six status checks above and require branches to be up to date before merging.
4. Set required approvals to `0` while this is a solo-maintainer repository. The checks remain
   mandatory, while a one-person repository is not deadlocked waiting for another reviewer.
5. Dismiss stale approvals when a new commit is pushed if approvals are later enabled.
6. Block force pushes and branch deletion.
7. Leave signed-commit enforcement disabled for now. There is no established signing-key
   provisioning, rotation, recovery, or contributor policy yet; enabling it prematurely could
   lock out the sole maintainer or legitimate contributors. Revisit it when that process exists.
8. Do not enable automatic merge as part of this task. A green check is a prerequisite, not an
   authorization to merge unreviewed dependency updates.

GitHub-native secret scanning and push protection are separate repository security settings. The
current API metadata reports them enabled, but the `Secret Scan` required check remains the
independent, repository-controlled history scan and should stay required.
