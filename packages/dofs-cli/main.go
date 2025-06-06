package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "dofs-cli",
	Short: "DOFS CLI - Distributed Object File System Command Line Interface",
	Long:  `A command line interface for managing and interacting with the Distributed Object File System (DOFS).`,
}

var mountCmd = &cobra.Command{
	Use:   "mount",
	Short: "Mount a DOFS filesystem",
	Long:  `Mount command for mounting a DOFS filesystem.`,
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("hello world")
	},
}

func init() {
	rootCmd.AddCommand(mountCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
