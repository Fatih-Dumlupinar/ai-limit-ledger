/**
 * Shared fixture values for the privacy-audit test suites.
 *
 * These tests have an unusual constraint: they must exercise values that the privacy audit is
 * *supposed to flag* — a realistic account name in a path, a real-looking mailbox, a LAN address, a
 * machine UUID. Writing those out as literals would put exactly the kind of data this repository
 * exists to keep out of itself into committed bytes, and `npm run audit:privacy` would (correctly)
 * fail on its own test files.
 *
 * Allowlisting the test files was the alternative, and it is the worse one: it would create a
 * permanent blind spot in precisely the files most likely to accumulate realistic example data over
 * time. Assembling each value at runtime keeps the audit's coverage total while the tests still
 * operate on the exact strings they claim to. This is the same convention
 * `test/ReleaseAudit.test.ts` already uses for its credential-shaped fixtures.
 *
 * Nothing here is a real person's account, mailbox, address, or machine.
 */

/** A deliberately realistic-looking account name — the thing that makes a path a finding. */
export const account = ['j', 'doe'].join('');

/** `C:\Users\<account>\...` on the given drive. */
export const windowsUserPathOn = (drive: string, ...segments: string[]): string =>
  [`${drive}:`, 'Users', account, ...segments].join('\\');

/** `C:\Users\<account>\...` */
export const windowsUserPath = (...segments: string[]): string =>
  windowsUserPathOn('C', ...segments);

/** `/home/<account>/...` or `/Users/<account>/...` */
export const posixHomePath = (base: 'home' | 'Users', ...segments: string[]): string =>
  ['', base, account, ...segments].join('/');

/** A mailbox that is not reserved for documentation, so it must classify as a finding. */
export const personalEmail = ['real.person', ['gmail', 'com'].join('.')].join('@');

/** An RFC 1918 private address. */
export const privateIpAddress = ['192', '168', '1', '14'].join('.');

/** A hardware address. */
export const macAddress = ['3c', '22', 'fb', '9a', '01', '7d'].join(':');

/** A UUID with no reserved-documentation or degenerate-placeholder structure. */
export const machineUuid = ['7f4d2c91', '3a6b', '4e5f', '9c8d', '1b2a3c4d5e6f'].join('-');

/** `\\<host>\<share>\...` */
export const uncPath = (...segments: string[]): string =>
  ['', '', ['build', 'host'].join(''), ...segments].join('\\');

/** A VS Code user-profile settings path under the account's roaming data. */
export const vscodeProfilePath = windowsUserPath(
  'AppData',
  'Roaming',
  'Code',
  'User',
  'settings.json',
);

/**
 * The userinfo separator is joined at runtime too: a literal `<secret>@<host>` in the source would
 * itself match the email pattern, which is exactly the kind of self-inflicted finding this module
 * exists to avoid.
 */
const userinfo = (secret: string, host: string) => [secret, host].join('@');

/** A database connection string carrying inline credentials. */
export const connectionString = [
  'postgres',
  '//svc',
  userinfo('hunter2', 'db.internal'),
  '5432/app',
].join(':');

/** An HTTPS URL carrying inline credentials in its userinfo component. */
export const credentialBearingUrl = [
  'https',
  '//svc',
  userinfo('hunter2', 'internal.example/repo'),
].join(':');

/** A long, random-looking literal that the entropy heuristic should flag. */
export const highEntropyLiteral = ['a9F2kQ7zX1mB', '4vN8pR3wL6tY', '0sJ5hG2dC7bV', '9nM4xZ'].join(
  '',
);

/** A source map whose `sources` entry points at an absolute build-machine path. */
export const sourceMapWithAbsolutePath = `{"version":3,"sources":["${['C', '/build/a.ts'].join(':')}"]}`;

/** The same source map shape, but correctly relative — must not be flagged. */
export const sourceMapWithRelativePath = '{"version":3,"sources":["../../src/a.ts"]}';
