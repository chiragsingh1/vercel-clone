const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const mime = require("mime-types");
const { Kafka, Partitioners } = require("kafkajs");

const s3Client = new S3Client({
    region: "",
    credentials: {
        accessKeyId: "",
        secretAccessKey: "",
    },
});

const PROJECT_ID = process.env.PROJECT_ID;
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID;

const kafka = new Kafka({
    clientId: `docker-build-server-${DEPLOYMENT_ID}`,
    brokers: [""],
    sasl: {
        username: "",
        password: "",
        mechanism: "plain",
    },
    ssl: {
        ca: [fs.readFileSync(path.join(__dirname, "kafka.pem"), "utf-8")],
    },
});

const producer = kafka.producer({
    createPartitioner: Partitioners.LegacyPartitioner,
});

async function publishLog(log) {
    await producer.send({
        topic: `container-logs`,
        messages: [
            {
                key: "log",
                value: JSON.stringify({ PROJECT_ID, DEPLOYMENT_ID, log }),
            },
        ],
    });
}

async function init() {
    await producer.connect();

    console.log("Executing script.js");

    await publishLog("Build Started...");

    const outDirPath = path.join(__dirname, "output");
    console.log("Output directory path:", outDirPath);

    const p = exec(`cd ${outDirPath} && npm install && npm run build`);

    p.stdout.on("data", async function (data) {
        console.log(data.toString());
        await publishLog(data.toString());
    });

    p.stdout.on("error", async function (data) {
        console.log("Error", data.toString());
        await publishLog(`error: ${data.toString()}`);
    });

    p.on("close", async function () {
        console.log("Build Complete");

        await publishLog(`Build Complete`);

        const distFolderPath = path.join(__dirname, "output", "dist");
        const distFolderContents = fs.readdirSync(distFolderPath, {
            recursive: true,
        });

        await publishLog(`Starting to upload`);

        for (const file of distFolderContents) {
            const filePath = path.join(distFolderPath, file);
            if (fs.lstatSync(filePath).isDirectory()) continue;

            console.log("uploading", filePath);
            await publishLog(`uploading ${file}`);

            const command = new PutObjectCommand({
                Bucket: "vercel-clone-s3-cs",
                Key: `__outputs/${PROJECT_ID}/${file}`,
                Body: fs.createReadStream(filePath),
                ContentType: mime.lookup(filePath),
            });

            await s3Client.send(command);

            await publishLog(`uploaded ${file}`);
            console.log("uploaded", filePath);
        }
        await publishLog(`Done`);
        console.log("Done...");
        process.exit(0);
    });
}

init();
