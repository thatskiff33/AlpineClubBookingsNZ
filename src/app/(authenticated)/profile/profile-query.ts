import { getSafeInternalReturnPath } from "@/lib/internal-return-path";

function singleSearchParam(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

export function profileQuery(params: {
  emailChangeError?: string | string[];
  emailChanged?: string | string[];
  returnTo?: string | string[];
  googleLinked?: string | string[];
  googleError?: string | string[];
}) {
  return {
    emailChangeError: singleSearchParam(params.emailChangeError),
    emailChanged: singleSearchParam(params.emailChanged) === "true",
    googleLinked: singleSearchParam(params.googleLinked) === "1",
    googleError: singleSearchParam(params.googleError),
    returnTo: getSafeInternalReturnPath(params.returnTo),
  };
}
