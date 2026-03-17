import { SignJWT } from "jose";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		sub: { type: "string", short: "s" },
		tenant: { type: "string", short: "t" },
		groups: { type: "string", short: "g" },
		secret: { type: "string", default: "sukko-dev-secret" },
		exp: { type: "string", default: "1h" },
	},
});

if (!values.sub || !values.tenant) {
	console.error("Usage: bun run token --sub <principal> --tenant <tenant_id> [--groups g1,g2] [--secret key] [--exp 1h]");
	process.exit(1);
}

const secret = new TextEncoder().encode(values.secret);
const groups = values.groups ? values.groups.split(",").map((g) => g.trim()) : [];

const jwt = await new SignJWT({
	sub: values.sub,
	tenant_id: values.tenant,
	groups,
})
	.setProtectedHeader({ alg: "HS256" })
	.setIssuedAt()
	.setExpirationTime(values.exp!)
	.sign(secret);

console.log(jwt);
console.log();
console.log("Claims:");
console.log(`  sub:       ${values.sub}`);
console.log(`  tenant_id: ${values.tenant}`);
console.log(`  groups:    ${groups.length > 0 ? groups.join(", ") : "(none)"}`);

const payload = JSON.parse(atob(jwt.split(".")[1]));
console.log(`  exp:       ${new Date(payload.exp * 1000).toISOString()}`);
