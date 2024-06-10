import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_ecs as ecs,
  aws_efs as efs,
} from "aws-cdk-lib";
import { Capability, LinuxParameters } from "aws-cdk-lib/aws-ecs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnEIP, IVpc } from "aws-cdk-lib/aws-ec2";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";

export interface WireguardVpnProps {
  /*
   * The VPC must have a public subnet
   * @default - Creates a new VPC for your VPN
   */
  vpc?: IVpc;
  /*
   * Cidrs Adresses to allow access to UI to.
   * Caution, you should probably restrict it to your office/Home IP
   * Or enable it/disable it only when you need to access the VPN UI (this is even  safer)
   * @default - []
   */
  allowedCidrsToUi?: cdk.aws_ec2.IPeer[];
  /*
   * Cidrs Adresses to allow access to UI to.
   * You could decide to restrict VPN access to some IPs only
   *
   * @default - ["0.0.0.0/0"] a.k.a.: All IPV4 Ip can attempt to connect to it
   */
  allowedCidrsToVPN?: cdk.aws_ec2.IPeer[];
}

export class WireguardVpn extends Construct {
  // Port used for VPN connection
  static readonly udpPort = 51820;
  // Port used To access UI
  static readonly tcpPort = 51821;
  // Get container to run
  static readonly containerImageName = "ghcr.io/wg-easy/wg-easy";
  static readonly dockerName = "wg-easy";

  public readonly hostInstanceIp: CfnEIP;

  constructor(scope: Construct, id: string, props: WireguardVpnProps = {}) {
    super(scope, id);

    // Create a New VPC dedicated to kiosks if not passed as a parameter
    const vpc =
      props.vpc ??
      new ec2.Vpc(this, "VPC", {
        subnetConfiguration: [
          {
            name: "public-subnet",
            // The VPC must have a public subnet as the VPN is public
            subnetType: ec2.SubnetType.PUBLIC,
            cidrMask: 24,
          },
        ],
      });

    // Create an elastic IP
    this.hostInstanceIp = new ec2.CfnEIP(this, "HostInstanceIp");

    // tagging with a unique ID to reference the EIP With
    const tagUniqueId = cdk.Names.uniqueId(this.hostInstanceIp);
    this.hostInstanceIp.tags.setTag("Name", tagUniqueId);

    // We will need a Filesystem to persist Wireguard Config Between reboots
    const fileSystem = new efs.FileSystem(this, "Efs", {
      vpc: vpc,
      encrypted: true,
    });

    const adminPassword = new cdk.aws_secretsmanager.Secret(
      this,
      "AdminPassword",
      {
        generateSecretString: {
          passwordLength: 64,
        },
      }
    );

    // Create ECS cluster the largest group in ECS
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    // Create an autoscaling groups -> i.e. : EC2 instance manager
    const autoscalingGroup = this.attachNewAutoscalingGroupTo(
      cluster,
      fileSystem,
      tagUniqueId
    );

    // Create a task definition for the ECS cluster
    const taskDefinition = this.buildTaskDef(
      fileSystem,
      this.hostInstanceIp.attrPublicIp,
      adminPassword
    );

    // Create an ECS Service with just cluster and image
    const service = new ecs.Ec2Service(this, "Service", {
      cluster,
      taskDefinition: taskDefinition,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      enableExecuteCommand: true,
    });

    // Allow anyone to mount this filesystem

    fileSystem.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["elasticfilesystem:ClientMount"],
        principals: [service.taskDefinition.taskRole],
        conditions: {
          Bool: {
            "elasticfilesystem:AccessedViaMountTarget": "true",
          },
        },
      })
    );

    for (const ip of props.allowedCidrsToUi ?? []) {
      // Autoscaling Group security group
      service.connections.allowFrom(ip, ec2.Port.tcp(WireguardVpn.tcpPort));
      // Autoscaling Group security group
      autoscalingGroup.connections.allowFrom(
        ip,
        ec2.Port.tcp(WireguardVpn.tcpPort)
      );
    }
    for (const ip of props.allowedCidrsToVPN ?? []) {
      // Autoscaling Group security group
      service.connections.allowFromAnyIpv4(ec2.Port.udp(WireguardVpn.udpPort));
      // Autoscaling Group security group
      autoscalingGroup.connections.allowFrom(
        ip,
        ec2.Port.tcp(WireguardVpn.udpPort)
      );
    }

    new cdk.CfnOutput(this, "VpnIpAddress", {
      value: this.hostInstanceIp.attrPublicIp,
    });

    new cdk.CfnOutput(this, "UiUrl", {
      value: `http://${this.hostInstanceIp.attrPublicIp}:${WireguardVpn.tcpPort}`,
    });
  }

  /**
   * This functions create an autoscaling group
   * An autoscaling group is an AWS resource that scale in or out a resource (EC2 in that case),
   * based on a set of rules
   *
   * Read more about auto scaling groups here : https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-groups.html
   *
   * In this case we want the autoscaling group to always have 1 EC2 instance running at all time
   *
   * When booting the ec2 instance will modify the r53 record so it redirects to its IP
   *
   * SSH is installed on instance when they boot: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html
   *
   * @param {ecs.Cluster} cluster - The cluster to attach the autoscaling group to.
   * @param {efs.FileSystem} fileSystem
   */
  attachNewAutoscalingGroupTo(
    cluster: ecs.Cluster,
    fileSystem: efs.FileSystem,
    tagUniqueId: string
  ) {
    // Here we ask for EC2 t4g.nano instances - to get the cheapest instance possible
    // Should be public ass it is a VPN anyway and we want to give it a static IP adress

    const hostAutoScalingGroup = cluster.addCapacity("AutoScalingGroup", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.NANO
      ),
      associatePublicIpAddress: true,

      // We need to specify ARM because t4g instances are ARM only
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(
        ecs.AmiHardwareType.ARM
      ),

      // We want exactly one EC2 instance running
      minCapacity: 1,
      maxCapacity: 1,
    });

    // Allow any IP to access the UDP port
    fileSystem.connections.allowDefaultPortFrom(
      hostAutoScalingGroup.connections
    );

    /**
     * Add policy to associate elastic ip on startup
     */
    hostAutoScalingGroup.role.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ec2:DescribeAddresses", "ec2:AssociateAddress"],
        resources: ["*"],
      })
    );

    // This is a bit special
    // When an instance boots, it'll automatically Attribute the elastic IP to itself.
    // Inspired from : https://github.com/rajyan/low-cost-ecs/blob/bc62fa06a507fc45665d0f87f061a4f8e62e9424/src/low-cost-ecs.ts#L223
    const awsCliTag = "latest";
    hostAutoScalingGroup.addUserData(
      'TOKEN=`curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"`',
      'INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
      `ALLOCATION_ID=$(docker run --net=host amazon/aws-cli:${awsCliTag} ec2 describe-addresses --region ${hostAutoScalingGroup.env.region} --filter Name=tag:Name,Values=${tagUniqueId} --query 'Addresses[].AllocationId' --output text | head)`,
      `docker run --net=host amazon/aws-cli:${awsCliTag} ec2 associate-address --region ${hostAutoScalingGroup.env.region} --instance-id "$INSTANCE_ID" --allocation-id "$ALLOCATION_ID" --allow-reassociation`
    );

    // Enable SSH through SSM
    hostAutoScalingGroup.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    // Enable SSH through SSM
    hostAutoScalingGroup.addUserData(
      "sudo yum install -y https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/linux_amd64/amazon-ssm-agent.rpm",
      "restart amazon-ssm-agent"
    );

    return hostAutoScalingGroup;
  }

  /**
   * Creates a Task Definition
   *
   * Read more about task definitions here : https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definitions.html
   *
   * @returns {ecs.TaskDefinition} taskDefinition - The built task definition
   */
  buildTaskDef(
    fileSystem: efs.FileSystem,
    ip: string,
    adminPassword: ISecret
  ): ecs.TaskDefinition {
    /* This is inspired from the normal way to run wg-easy on docker: 
    $ docker run -d \
      --name=wg-easy \
      -e WG_HOST=🚨YOUR_SERVER_IP \
      -e PASSWORD=🚨YOUR_ADMIN_PASSWORD \
      -v ~/.wg-easy:/etc/wireguard \
      -p 51820:51820/udp \
      -p 51821:51821/tcp \
      --cap-add=NET_ADMIN \
      --cap-add=SYS_MODULE \
      --sysctl="net.ipv4.conf.all.src_valid_mark=1" \
      --sysctl="net.ipv4.ip_forward=1" \
      --restart unless-stopped \
      ghcr.io/wg-easy/wg-easy
    */

    const taskDefinition = new ecs.Ec2TaskDefinition(this, "TaskDef", {
      volumes: [
        {
          name: "confs",
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
          },
        },
      ],
    });

    const lp = new LinuxParameters(this, "LinuxParam", {});
    lp.addCapabilities(Capability.NET_ADMIN, Capability.SYS_MODULE);

    const containerDef = taskDefinition.addContainer("Container", {
      pseudoTerminal: true,
      startTimeout: cdk.Duration.seconds(300),
      privileged: false,
      image: ecs.ContainerImage.fromRegistry(WireguardVpn.containerImageName),
      memoryReservationMiB: 100,
      cpu: 1024,
      environment: {
        WG_HOST: ip,
      },
      secrets: {
        PASSWORD: ecs.Secret.fromSecretsManager(adminPassword),
      },
      portMappings: [
        {
          containerPort: WireguardVpn.tcpPort,
          hostPort: WireguardVpn.tcpPort,
          protocol: ecs.Protocol.TCP,
        },
        {
          containerPort: WireguardVpn.udpPort,
          hostPort: WireguardVpn.udpPort,
          protocol: ecs.Protocol.UDP,
        },
      ],
      systemControls: [
        {
          namespace: "net.ipv4.conf.all.src_valid_mark",
          value: "1",
        },
        {
          namespace: "net.ipv4.ip_forward",
          value: "1",
        },
      ],
      linuxParameters: lp,
    });

    containerDef.addMountPoints({
      sourceVolume: "confs",
      containerPath: "/etc/wireguard",
      readOnly: false,
    });

    adminPassword.grantRead(taskDefinition.taskRole.grantPrincipal);
    fileSystem.grantRootAccess(taskDefinition.taskRole.grantPrincipal);

    return taskDefinition;
  }
}
