import axios from 'axios';

const helloworld = "ZWU1MGEzNzMtOWFkNS00M2VlLTlmNzktNmViMGYxOTgwOTE0OjJhYWExMDM3YzM5ODVhMzdiNzdlNWYxM2IxZDZmNGI2"

export async function bloxroutetx(transaction) {
    const url = "https://ny.solana.dex.blxrbdn.com/api/v2/submit"
    const headers = {
        "Authorization": `${helloworld}`
    }

    const body = {
        transaction: {
            content: transaction,
            isCleanup: false
        },
        skipPreFlight: true,
        frontRunningProtection: false,
        useStakedRPCs: true
    }

    const { data: { signature } } = await axios.post(url, body, { headers })

    return signature
}