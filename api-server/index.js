const express = require("express");
const { generateSlug } = require("random-word-slugs");
const { ECSClient, RunTaskCommand } = require("@aws-sdk/client-ecs");
const cors = require("cors");
const { z } = require("zod");
const { PrismaClient } = require("@prisma/client");
const { createClient } = require("@clickhouse/client");
const { Kafka } = require("kafkajs");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 9000;

app.use(express.json());
app.use(cors());

const prisma = new PrismaClient({});

const kafka = new Kafka({
    clientId: `api-server`,
    brokers: ["kafka-122c7c8e-atthani-db.i.aivencloud.com:22438"],
    sasl: {
        username: "",
        password: "",
        mechanism: "plain",
    },
    ssl: {
        ca: [fs.readFileSync(path.join(__dirname, "kafka.pem"), "utf-8")],
    },
});

const client = createClient({
    host: "https://clickhouse-351470c9-atthani-db.i.aivencloud.com:22426",
    database: "default",
    username: "",
    password: "",
});

const consumer = kafka.consumer({
    groupId: "api-server-logs-consumer",
});

const ecsClient = new ECSClient({
    region: "ap-south-1",
    credentials: {
        accessKeyId: "",
        secretAccessKey: "",
    },
});

const config = {
    CLUSTER: "arn:aws:ecs:ap-south-1:975050349192:cluster/builderCluster",
    TASK: "arn:aws:ecs:ap-south-1:975050349192:task-definition/builder-task-ecs",
};

app.post("/project", async (req, res) => {
    const schema = z.object({
        name: z.string(),
        gitURL: z.string(),
    });
    const safeParseResult = schema.safeParse(req.body);

    if (safeParseResult.error)
        return res.status(400).json({ error: safeParseResult.error });

    const { name, gitURL } = safeParseResult.data;

    const project = await prisma.project.create({
        data: {
            name,
            gitURL,
            subDomain: generateSlug(),
        },
    });

    return res.json({ status: "success", data: { project } });
});

app.post("/deploy", async (req, res) => {
    const { projectId } = req.body;

    const project = await prisma.project.findUnique({
        where: { id: projectId },
    });

    if (!project) return res.status(404).json({ error: "Project not found" });

    // Check if there is no running deployement
    const deployment = await prisma.deployment.create({
        data: {
            project: { connect: { id: projectId } },
            status: "QUEUED",
        },
    });

    // Spin the container
    const command = new RunTaskCommand({
        cluster: config.CLUSTER,
        taskDefinition: config.TASK,
        launchType: "FARGATE",
        count: 1,
        networkConfiguration: {
            awsvpcConfiguration: {
                assignPublicIp: "ENABLED",
                subnets: [
                    "subnet-012f6a24a2b6f6c4d",
                    "subnet-0ff5be5fbf03620c4",
                    "subnet-07b343b7a42c47b46",
                ],
                securityGroups: ["sg-05e803ba88c7deb3b"],
            },
        },
        overrides: {
            containerOverrides: [
                {
                    name: "builder-image",
                    environment: [
                        { name: "GIT_REPOSITORY__URL", value: project.gitURL },
                        { name: "PROJECT_ID", value: projectId },
                        { name: "DEPLOYMENT_ID", value: deployment.id },
                    ],
                },
            ],
        },
    });

    await ecsClient.send(command);

    return res.json({
        status: "queued",
        data: { deploymentId: deployment.id },
    });
});

app.get("/logs/:id", async (req, res) => {
    const id = req.params.id;
    const logs = await client.query({
        query: `SELECT event_id, deployment_id, log, timestamp from log_events where deployment_id = {deployment_id:String}`,
        query_params: {
            deployment_id: id,
        },
        format: "JSONEachRow",
    });

    const rawLogs = await logs.json();

    return res.json({ logs: rawLogs });
});

async function initkafkaConsumer() {
    await consumer.connect();
    await consumer.subscribe({
        topics: ["container-logs"],
        fromBeginning: true,
    });

    await consumer.run({
        autoCommit: false,
        eachBatch: async function ({
            batch,
            heartbeat,
            commitOffsetsIfNecessary,
            resolveOffset,
        }) {
            const messages = batch.messages;
            console.log(`Received ${messages.length} messages..`);
            for (const message of messages) {
                if (!message.value) continue;
                const stringMessage = message.value.toString();
                const { PROJECT_ID, DEPLOYMENT_ID, log } =
                    JSON.parse(stringMessage);
                console.log({ log, DEPLOYMENT_ID });
                try {
                    const { query_id } = await client.insert({
                        table: "log_events",
                        values: [
                            {
                                event_id: uuidv4(),
                                deployment_id: DEPLOYMENT_ID,
                                log,
                            },
                        ],
                        format: "JSONEachRow",
                    });
                    console.log(query_id);
                    resolveOffset(message.offset);
                    await commitOffsetsIfNecessary(message.offset);
                    await heartbeat();
                } catch (err) {
                    console.log(err);
                }
            }
        },
    });
}

initkafkaConsumer();

app.listen(PORT, () => console.log(`API Server Running..${PORT}`));
