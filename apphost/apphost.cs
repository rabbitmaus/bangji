#:sdk Aspire.AppHost.Sdk@13.6.4
#:package Aspire.Hosting.Azure.AppContainers@13.6.4
#:package Aspire.Hosting.Azure.CosmosDB@13.6.4
#:package Aspire.Hosting.Azure.Storage@13.6.4
#:package Aspire.Hosting.Azure.ApplicationInsights@13.6.4

using Aspire.Hosting.Azure;
using Azure.Provisioning;
using Azure.Provisioning.AppContainers;
using Azure.Provisioning.CosmosDB;
using Azure.Provisioning.Storage;

var builder = DistributedApplication.CreateBuilder(args);

builder.AddAzureContainerAppEnvironment("env");

var copilotToken = builder.AddParameter("copilot-github-token", secret: true);
var cookieSecret = builder.AddParameter("guest-cookie-secret", secret: true);
// Optional: when set, custom URLs open in a Browserbase remote browser instead of the local Chromium.
// Aspire has no optional secret parameter, so the parameter is only declared when a value is configured
// (Parameters:browserbase-api-key / env Parameters__browserbase_api_key).
var browserbaseKeyValue = builder.Configuration["Parameters:browserbase-api-key"]
    ?? builder.Configuration["Parameters:browserbase_api_key"];
var browserbaseKey = string.IsNullOrWhiteSpace(browserbaseKeyValue)
    ? null
    : builder.AddParameter("browserbase-api-key", secret: true);
var copilotModel = builder.AddParameter("copilot-model", "gpt-5", publishValueAsDefault: true);
var evaluatorModel = builder.AddParameter("github-copilot-model", "gpt-5", publishValueAsDefault: true);

// Cosmos DB: serverless (Aspire default), key auth off, workspace documents expire after 7 days.
var cosmos = builder.AddAzureCosmosDB("cosmos")
    .ConfigureInfrastructure(infra =>
    {
        var resources = infra.GetProvisionableResources();
        var account = resources.OfType<CosmosDBAccount>().Single();
        account.DisableLocalAuth = true;
        foreach (var container in resources.OfType<CosmosDBSqlContainer>())
        {
            container.Resource.DefaultTtl = 604800;
        }
    });
var db = cosmos.AddCosmosDatabase("bangji");
var data = db.AddContainer("workspace-data", "/workspaceId");

// Storage: shared key off, blobs under ws/ are deleted after 7 days.
var storage = builder.AddAzureStorage("storage")
    .ConfigureInfrastructure(infra =>
    {
        var account = infra.GetProvisionableResources().OfType<StorageAccount>().Single();
        account.AllowSharedKeyAccess = false;
        account.AllowBlobPublicAccess = false;
        var policy = new StorageAccountManagementPolicy("lifecycle")
        {
            Parent = account,
            Rules =
                {
                    new ManagementPolicyRule
                    {
                        Name = "delete-ws-after-7d",
                        RuleType = ManagementPolicyRuleType.Lifecycle,
                        IsEnabled = true,
                        Definition = new ManagementPolicyDefinition
                        {
                            Filters = new ManagementPolicyFilter
                            {
                                BlobTypes = { "blockBlob" },
                                PrefixMatch = { "artifacts/ws/" },
                            },
                            Actions = new ManagementPolicyAction
                            {
                                BaseBlob = new ManagementPolicyBaseBlob
                                {
                                    Delete = new DateAfterModification { DaysAfterModificationGreaterThan = 7 },
                                },
                            },
                        },
                    },
                },
        };
        infra.Add(policy);
    });
var blobs = storage.AddBlobs("blobs");
var artifacts = blobs.AddBlobContainer("artifacts");

var insights = builder.AddAzureApplicationInsights("insights");

var evaluator = builder.AddDockerfile("evaluator", "../evaluator")
    .WithHttpEndpoint(targetPort: 8000)
    .WithEnvironment("COPILOT_GITHUB_TOKEN", copilotToken)
    .WithEnvironment("GITHUB_COPILOT_MODEL", evaluatorModel)
    .WithEnvironment("GITHUB_COPILOT_TIMEOUT", "60")
    .WithEnvironment("APPLICATIONINSIGHTS_CONNECTION_STRING", insights.Resource.ConnectionString)
    .PublishAsAzureContainerApp((infra, app) =>
    {
        app.Template.Containers[0].Value!.Resources = new AppContainerResources { Cpu = 1.0, Memory = "2Gi" };
        app.Template.Scale.MinReplicas = 1;
        app.Template.Scale.MaxReplicas = 1;
    });

var web = builder.AddDockerfile("web", "../web")
    .WithHttpEndpoint(targetPort: 8080)
    .WithExternalHttpEndpoints()
    .WithReference(data)
    .WithReference(artifacts)
    .WithRoleAssignments(storage, StorageBuiltInRole.StorageBlobDataContributor)
    .WithEnvironment("APPLICATIONINSIGHTS_CONNECTION_STRING", insights.Resource.ConnectionString)
    .WithEnvironment("EVALUATOR_URL", evaluator.GetEndpoint("http"))
    .WithEnvironment("COPILOT_GITHUB_TOKEN", copilotToken)
    .WithEnvironment("GUEST_COOKIE_SECRET", cookieSecret)
    .WithEnvironment("COPILOT_MODEL", copilotModel)
    .WithEnvironment("LIMIT_PREP_PER_HOUR", Environment.GetEnvironmentVariable("LIMIT_PREP_PER_HOUR") ?? "20")
    .WithEnvironment("LIMIT_ASSISTANT_PER_HOUR", Environment.GetEnvironmentVariable("LIMIT_ASSISTANT_PER_HOUR") ?? "60")
    .PublishAsAzureContainerApp((infra, app) =>
    {
        app.Template.Containers[0].Value!.Resources = new AppContainerResources { Cpu = 2.0, Memory = "4Gi" };
        app.Template.Scale.MinReplicas = 1;
        app.Template.Scale.MaxReplicas = 1;
    });

if (browserbaseKey is not null)
{
    web.WithEnvironment("BROWSERBASE_API_KEY", browserbaseKey);
}

builder.Build().Run();
