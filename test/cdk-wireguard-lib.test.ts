import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as wg from "../lib/index";

test("ECS Cluster Created", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  //   // WHEN
  new wg.WireguardVpn(stack, "TestVpn");

  // THEN
  const template = Template.fromStack(stack);

  console.log(template);

  template.hasResource("AWS::ECS::Cluster", {});
});
