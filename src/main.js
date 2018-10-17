/*jshint esversion: 6 */
const https = require('https');
const express = require("express");
const request = require("request");
const bodyParser = require("body-parser");
const oauth = require('oauth');
const databox = require('node-databox');

const MonzoDefaultSettings = require('./monzo-secret.json');

const DATABOX_ZMQ_ENDPOINT = process.env.DATABOX_ZMQ_ENDPOINT;

const credentials = databox.getHttpsCredentials();

const PORT = process.env.port || '8080';

const app = express();

app.use(bodyParser.urlencoded({extended: true}));

let timer = setInterval(timer_callback, 1000 * 60);  // per minute
let next_token_refresh = null;
let next_data_refresh = null;

// Step 1: Auth with Monzo
app.get('/ui', function (req, res) {
    getSettings()
    .then((settings) => {
        const { client_id, redirect_uri } = settings;
        const monzoAuthUrl = 'https://auth.monzo.com';

        res.type('html');
        // TODO: Use a pug template instead
        res.send(`
        <h1>Monzo Driver Authentication</h1>
        <form action="${monzoAuthUrl}">
            Accounts:<br>
            <input type="hidden" name="client_id" value="${client_id}" />
            <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
            <input type="hidden" name="response_type" value="code" />
            <button>Authorise</button>
        </form>
        `);
    });
});

// Step 2: Get OAuth token
app.get('/oauth/callback', (req, res) => {
    getSettings()
    .then((settings) => {
        const { client_id, client_secret, redirect_uri } = settings;
        const { code } = req.query;

        request.post({
            url: `https://api.monzo.com/oauth2/token`,
            form: {
                grant_type: 'authorization_code',
                client_id,
                client_secret,
                redirect_uri,
                code
            }
        }, (err, response, body) => {
            settings.auth_details = JSON.parse(body);
            setSettings(settings)
            .then(() => {
                res.redirect('/configure');
            });
        });
    });
});

// Step 3: Configure Monzo Driver
// (i.e. choose the Account you want to monitor)
app.get('/configure', (req, res) => {
    getSettings()
    .then((settings) => {
        const { token_type, access_token } = settings.accessToken;

        request.get('https://api.monzo.com/accounts', {
            headers: {
                Authorization: `${token_type} ${access_token}`
            }
        }, (req, response, body) => {
            const { accounts } = JSON.parse(body);

            res.type('html');
            // TODO: Use a pug template instead
            res.write('<h1>Monzo Driver Configuration</h1>');
            res.write('<p>Please choose the account you want to monitor and its refresh interval:</p>');
            res.write('<form action="/saveConfiguration">');
            res.write('Accounts:<br>');

            for(let account of accounts) {
                const {id, type, description } = account;
                res.write(`
                    <input type="radio" name="account" value="${id}"> ${description} (<i>${type}</i>)<br><br>
                    `);
            }
            res.write('Refresh Interval (minutes): <input type="text" name="refresh_interval" value="30"><br><br>');
            res.write('<button>Save Configuration</button>');
            res.end('</form>');
        });
    });
});

// Step 4: Parse response and save configuration
app.get('/saveConfiguration', function (req, res) {
    let newAccount = req.query.account;
    let newRefreshInterval = req.query.refresh_interval;
    console.log(newAccount);
    console.log(newRefreshInterval);

    getSettings()
    .then((settings) => {
        settings.account_id = newAccount;
        settings.refresh_interval = newRefreshInterval;
        console.log("[SETTINGS]", settings);
        return setSettings(settings);
    })
    .then((settings) => {
        // Start/Restart monitoring with new settings
        refresh_data();
    })
    .catch((error) => {
        console.log("[saveConfiguration] Error ", error);
        res.status(400).send({statusCode: 400, body: "error saving configuration settings."});
    });
});

app.get("/status", function (req, res) {
    res.send("active");
});

console.log("[Creating server]");
https.createServer(credentials, app).listen(PORT);
module.exports = app;

let tsc = databox.NewTimeSeriesBlobClient(DATABOX_ZMQ_ENDPOINT, false);
let kvc = databox.NewKeyValueClient(DATABOX_ZMQ_ENDPOINT, false);

let balance = databox.NewDataSourceMetadata();
balance.Description = 'Monzo Bank user Balance data';
balance.ContentType = 'application/json';
balance.Vendor = 'Databox Inc.';
balance.DataSourceType = 'monzoUserBalance';
balance.DataSourceID = 'monzoUserBalance';
balance.StoreType = 'ts';

let transactions = databox.NewDataSourceMetadata();
transactions.Description = 'Monzo Bank user Transactions data';
transactions.ContentType = 'application/json';
transactions.Vendor = 'Databox Inc.';
transactions.DataSourceType = 'monzoUserTransactions';
transactions.DataSourceID = 'monzoUserTransactions';
transactions.StoreType = 'ts';

let driverSettings = databox.NewDataSourceMetadata();
driverSettings.Description = 'Monzo driver settings';
driverSettings.ContentType = 'application/json';
driverSettings.Vendor = 'Databox Inc.';
driverSettings.DataSourceType = 'monzoSettings';
driverSettings.DataSourceID = 'monzoSettings';
driverSettings.StoreType = 'kv';

tsc.RegisterDatasource(balance)
    .then(() => {
        return tsc.RegisterDatasource(transactions);
    })
    .then(() => {
        return kvc.RegisterDatasource(driverSettings);
    })
    .catch((err) => {
        console.log("Error registering data source:" + err);
    });

function getSettings() {
    datasourceid = 'monzoSettings';
    return new Promise((resolve, reject) => {
        kvc.Read(datasourceid, "settings")
        .then((settings) => {
            console.log("[getSettings] read response = ", settings);
            if (Object.keys(settings).length === 0) {
                //return defaults
                let settings = MonzoDefaultSettings;
                settings.redirect_uri = "http://localhost:3000/oauth/callback";
                console.log("[getSettings] using defaults Using ----> ", settings);
                resolve(settings);
                return;
            }
            console.log("[getSettings]", settings);
            resolve(settings);
        })
        .catch((err) => {
            let settings = MonzoDefaultSettings;
            settings.redirect_uri = "http://localhost:3000/oauth/callback";
            console.log("[getSettings] using defaults Using ----> ", settings);
            resolve(settings);
        });
    });
}

function setSettings(settings) {
    let datasourceid = 'monzoSettings';
    return new Promise((resolve, reject) => {
        kvc.Write(datasourceid, "settings", settings)
        .then(() => {
            console.log('[setSettings] settings saved', settings);
            resolve(settings);
        })
        .catch((err) => {
            console.log("Error setting settings", err);
            reject(err);
        });
    });
}

function save(datasourceid, data) {
    console.log("Saving monzo event::", data.text);
    json = {"data": data};
    tsc.Write(datasourceid, data)
    .then((resp) => {
        console.log("Save got response ", resp);
    })
    .catch((error) => {
        console.log("Error writing to store:", error);
    });
}

// Should be called periodically to refresh the token before it expires
// expires_in 6 hours, but it should be dynamic
// TODO
function refresh_token() {
    getSettings()
    .then((settings) => {
        const { client_id, client_secret, auth_details } = settings;

        request.post({
            url: `https://api.monzo.com/oauth2/token`,
            form: {
                grant_type: 'refresh_token',
                client_id,
                client_secret,
                refresh_token: auth_details.access_token
            }
        }, (err, response, body) => {
            settings.auth_details = JSON.parse(body);
            setSettings(settings);
        });
    });
}

function timer_callback() {

    getSettings()
    .then((settings) => {
        const {refresh_interval} = settings.refresh_interval;

        // current datetime
        var now = newDate();

        if (next_token_refresh == null ||
            next_token_refresh < now) {

            refresh_token();

            // plan next refresh
            next_token_refresh = Date().setMinutes(now.getMinutes() + 60); // 1 hour
        }

        if (next_data_refresh == null ||
            next_data_refresh < now) {
            refresh_balance();
            refresh_transactions();

            // plan next refresh
            next_data_refresh = Date().setMinutes(now.getMinutes() + refresh_interval);
        }
    });
}

function refresh_balance() {
    getSettings()
    .then((settings) => {
        const { auth_details, account_id } = settings;
        const balanceUrl = `https://api.monzo.com/balance?account_id=${account_id}`;

        request.get(balanceUrl, {
            headers: {
                Authorization: `${auth_details.token_type} ${auth_details.access_token}`
            }
        }, (req, response, body) => {
            const { balance } = JSON.parse(body);
            save('monzoUserBalance', transactions);
        });
    });
}

function refresh_transactions() {
    getSettings()
    .then((settings) => {
        const { auth_details, account_id } = settings;
        const transactionsUrl = `https://api.monzo.com/transactions?account_id=${account_id}`;

        request.get(transactionsUrl, {
            headers: {
                Authorization: `${auth_details.token_type} ${auth_details.access_token}`
            }
        }, (req, response, body) => {
            const { transactions } = JSON.parse(body);
            save('monzoUserTransactions', transactions);
        });
    });
}
