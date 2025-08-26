terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.0"
}

provider "aws" {
  region = var.aws_region
}

# Variables
variable "aws_region" {
  description = "AWS region for deployment"
  default     = "us-east-1"  # Best for Solana
}

variable "instance_type" {
  description = "EC2 instance type"
  default     = "t3.medium"  # Good balance of performance/cost
}

variable "key_pair_name" {
  description = "Name of existing EC2 key pair for SSH access"
  type        = string
}

# VPC and Networking
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "copy-trader-vpc"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = {
    Name = "copy-trader-public-subnet"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "copy-trader-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "copy-trader-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Security Group
resource "aws_security_group" "copy_trader" {
  name        = "copy-trader-sg"
  description = "Security group for Copy Trading Bot"
  vpc_id      = aws_vpc.main.id

  # SSH
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]  # Restrict to your IP in production
  }

  # Dashboard
  ingress {
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # WebSocket API
  ingress {
    from_port   = 4789
    to_port     = 4789
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "copy-trader-sg"
  }
}

# EC2 Instance
resource "aws_instance" "copy_trader" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  key_name      = var.key_pair_name
  subnet_id     = aws_subnet.public.id
  
  vpc_security_group_ids = [aws_security_group.copy_trader.id]

  root_block_device {
    volume_type = "gp3"
    volume_size = 30
    encrypted   = true
  }

  user_data = file("${path.module}/../ec2-setup.sh")

  tags = {
    Name = "copy-trader-bot"
    Type = "trading-bot"
  }
}

# Get latest Ubuntu AMI
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]  # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Elastic IP (optional - for static IP)
resource "aws_eip" "copy_trader" {
  instance = aws_instance.copy_trader.id
  domain   = "vpc"

  tags = {
    Name = "copy-trader-eip"
  }
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "copy_trader" {
  name              = "/aws/ec2/copy-trader"
  retention_in_days = 7

  tags = {
    Application = "copy-trader"
  }
}

# Outputs
output "instance_public_ip" {
  description = "Public IP of the EC2 instance"
  value       = aws_eip.copy_trader.public_ip
}

output "instance_id" {
  description = "ID of the EC2 instance"
  value       = aws_instance.copy_trader.id
}

output "dashboard_url" {
  description = "URL to access the dashboard"
  value       = "http://${aws_eip.copy_trader.public_ip}:3000"
}

output "ssh_command" {
  description = "SSH command to connect to instance"
  value       = "ssh -i ${var.key_pair_name}.pem ubuntu@${aws_eip.copy_trader.public_ip}"
}