const { exec } = require('../../../src/utils');

describe('CML e2e', () => {
  test('cml-ci --help', async () => {
    const output = await exec(`echo none | node ./bin/cml.js ci --help`);

    expect(output).toMatchInlineSnapshot(`
      "cml.js ci

      Prepare Git repository for CML operations

      Global Options:
        --log     Logging verbosity
                [string] [choices: \\"error\\", \\"warn\\", \\"info\\", \\"debug\\"] [default: \\"info\\"]
        --driver  Git provider where the repository is hosted
          [string] [choices: \\"github\\", \\"gitlab\\", \\"bitbucket\\"] [default: infer from the
                                                                          environment]
        --repo    Repository URL or slug[string] [default: infer from the environment]
        --token   Personal access token [string] [default: infer from the environment]
        --help    Show help                                                  [boolean]

      Options:
        --fetch-depth  Number of commits to fetch. 0 indicates all history for all
                       branches and tags                         [number] [default: 1]
        --user-email   Git user email        [string] [default: \\"olivaw@iterative.ai\\"]
        --user-name    Git user name                 [string] [default: \\"Olivaw[bot]\\"]"
    `);
  });
});
