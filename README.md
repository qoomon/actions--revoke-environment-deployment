> [!CAUTION]
> This action is not working as intended.
> If you use the `job.environment` field a deployment will be created before the job starts.
> This deployment will be deleted as expected.
> However, after the job has been completed GitHub tries to set a success deployment state of job deployment created before.
> Because the deployment has been deleted GitHub just creates a new one instead to set the success state 🤯.

# Revoke Environment Deployment
This actions revokes the implicit deployment when using the `environment` key in a job.

### Usage
```yaml
jobs:
  example:
    runs-on: ubuntu-latest
    environment: playground
    permissions:
      actions: read # required for qoomon/actions--revoke-environment-deployment
      deployments: write # required for qoomon/actions--revoke-environment-deployment
      contents: read
    steps:
      - uses: qoomon/actions--revoke-environment-deployment@v1
```


#### Release New Action Version
- Trigger the [Release workflow](../../actions/workflows/release.yaml)
  - The workflow will create a new release with the given version and also move the related major version tag e.g. `v1` to point to this new release
